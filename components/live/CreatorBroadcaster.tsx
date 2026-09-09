'use client';

/**
 * The publisher half of /creator/live: the camera, the filter canvas, the
 * LiveKit connection, and the call that starts delivery to the CDN.
 *
 * WHAT THE PIPELINE LOOKS LIKE FROM HERE
 *
 *   getUserMedia --> canvas (the look) --> LiveKit publish --> RoomComposite
 *     egress --> RTMP --> Bunny Live --> LL-HLS --> viewers
 *
 * Two of those arrows are new and both matter:
 *
 *  - THE CANVAS. The camera is opened here rather than by LiveKit's
 *    `setCameraEnabled`, because the frames have to pass through a canvas that
 *    applies the creator's chosen look before anything encodes them. That is
 *    what makes the filter visible to viewers; until this migration it was a
 *    CSS effect on the creator's own screen and the UI had to admit as much.
 *  - THE EGRESS. Started AFTER the publisher is connected and publishing, not
 *    at go-live. An egress bills per minute from the moment it starts, and
 *    starting it when the session row is created would charge an abandoned
 *    go-live for compositing an empty room.
 *
 * The room contains the creator and, once delivery starts, LiveKit's egress
 * worker. It does NOT contain the audience — viewers pull HLS from a CDN — so
 * the viewer count and the reactions floating over the self-view both come
 * from the Supabase Realtime channel, via the page. This component receives
 * them as props and owns neither.
 *
 * One write to `live_sessions` happens from here: persistViewerCounts. The
 * peak it maintains is what live-end-session reads to build the session
 * summary AND to price the broadcast, and nothing else writes it. Best-effort
 * — a refused write is logged, never surfaced. Nothing about a wrong number is
 * worth interrupting a broadcast for.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Camera,
  Loader2,
  Mic,
  MicOff,
  ScreenShare,
  ScreenShareOff,
  Sparkles,
  Video,
  VideoOff,
  WifiOff,
} from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { markSessionLive, persistViewerCounts, startLiveEgress } from '@/lib/live/api';
import {
  EGRESS_START_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAY_MS,
  WHIP_ICE_GRACE_MS,
  VIEWER_PERSIST_MS,
} from '@/lib/live/constants';
import {
  applyZoomConstraint,
  describeCamera,
  hardwareZoomRange,
  openCamera,
  type CameraOpenResult,
  type ZoomRange,
} from '@/lib/live/cameraCapture';
import {
  RoomEvent,
  Track,
  connectAsPublisher,
  createRoom,
  leaveRoom,
  localPublication,
  resolutionFor,
  thaiForConnectError,
  thaiForMediaError,
  type CameraFacing,
  type Room,
} from '@/lib/live/livekitClient';
import { publishWhip, thaiForWhipError, type WhipSession } from '@/lib/live/whipClient';
import type { BroadcastQuality, LiveDelivery } from '@/lib/live/types';
import {
  createFilteredStream,
  filterLabelFor,
  isDesktopBroadcastViewport,
  type FilteredStream,
  type FilterId,
  type LookMode,
} from '@/lib/live/cameraFilters';
import {
  isScreenShareSupported,
  startScreenShare,
  type ScreenShareSession,
} from '@/lib/live/screenShareCapture';
import {
  COMPOSITE_FRAME_RATE,
  COMPOSITE_LAYOUT_LABELS,
  COMPOSITE_LAYOUT_ORDER,
  DEFAULT_COMPOSITE_LAYOUT,
  DEFAULT_PIP_CORNER,
  PIP_CORNER_LABELS,
  PIP_CORNER_ORDER,
  compositeSizeFor,
} from '@/lib/live/compositeCanvas';
import type { CompositeLayout, PipCorner } from '@/lib/live/compositeCanvas';
import {
  isDefaultOrientation,
  shouldFlipPreview,
  type CameraOrientation,
} from '@/lib/live/cameraOrientation';
import type { FloatingReaction } from '@/lib/live/reactions';
import { CameraControlsMenu, OrientationChangedBadge } from './CameraControlsMenu';
import { CameraFilterSelector } from './CameraFilterSelector';
import { FloatingReactionsLayer } from './FloatingReactionsLayer';
import { DurationPill, LiveBadge, ViewerCountPill } from './LiveStatsBar';

export type BroadcastPhase = 'connecting' | 'live' | 'reconnecting' | 'failed';

interface CreatorBroadcasterProps {
  liveSessionId: string;
  wsUrl: string;
  /** SECURITY: a LiveKit room credential. Never log it or put it in a URL. */
  token: string;
  /**
   * SECURITY: the WHIP publish capability, on an origin session only.
   *
   * Anyone holding this URL can publish into the creator's broadcast — MediaMTX
   * grants a path to whoever reaches it first — so it gets the same treatment
   * as `token` above: never logged, never in a URL, never persisted.
   * Empty string on the other two pipelines.
   */
  whipUrl: string;
  quality: BroadcastQuality;
  /**
   * 'llhls' when a Bunny stream exists; 'livekit' when its create fell back;
   * 'origin' when the creator publishes WHIP to our own MediaMTX. The third
   * takes an entirely different publish path — no room, no token, no egress.
   */
  delivery: LiveDelivery;
  videoDeviceId?: string;
  micEnabled: boolean;
  elapsedSeconds: number;
  /** The look chosen on the setup screen; changeable from the bottom bar. */
  filterId: FilterId;
  onFilterIdChange: (id: FilterId) => void;
  /**
   * Which way round the picture faces, for the creator and for viewers.
   *
   * Held by the page (and persisted there) for the same reason the look is:
   * this component mounts at go-live, and a preference chosen on the setup
   * screen has to survive the swap.
   */
  orientation: CameraOrientation;
  onOrientationChange: (next: CameraOrientation) => void;
  /** From the Realtime channel's presence, via the page. */
  viewerCount: number;
  /** The viewers' reactions, floating over the self-view. Received, never sent. */
  reactions: FloatingReaction[];
  /**
   * Painted over the self-view — the gift overlay.
   *
   * A slot rather than an import, for the same reason the players take one: the
   * overlay positions itself against this component's own container, and a
   * broadcaster that knew about gifts would be a broadcaster that has to change
   * the next time something else needs to sit over the video.
   */
  overlay?: React.ReactNode;
  onPhaseChange?: (phase: BroadcastPhase) => void;
  /**
   * How this is dressed, not what it publishes. Same split as the players.
   *
   * 'framed' is the desktop studio: a bordered 16:9-ish box with the LIVE and
   * viewer pills in its corners and the control row beneath it.
   *
   * 'fullbleed' is the phone host layout. The self-view fills the viewport and
   * every control is a translucent layer the PAGE owns and positions against
   * the safe areas — including the one that ends the broadcast, which on the
   * squeezed-down desktop studio was pushed off-screen entirely and left a
   * creator with no way to stop. So this draws the picture and nothing else,
   * and hands its controls out through `controls`.
   */
  presentation?: BroadcastPresentation;
  /**
   * Ask the camera for a portrait frame.
   *
   * The whole reason a phone broadcast came out landscape-shaped: the quality
   * rungs are expressed in landscape, so a phone held upright was asking a
   * portrait camera for 1280x720 and getting it. Escalated and verified rather
   * than assumed — see lib/live/cameraCapture.ts.
   */
  portrait?: boolean;
  /**
   * Which camera to open on a device that has more than one. Ignored when
   * `videoDeviceId` names a specific camera — a desktop picks by id, a phone
   * picks by facing.
   */
  facingMode?: CameraFacing;
  /** Told when the creator flips the camera, so the page can remember it. */
  onFacingModeChange?: (next: CameraFacing) => void;
  /**
   * The control surface, for a layout that draws its own.
   *
   * A render prop rather than a set of exported handles because the state it
   * needs — the mute flags, the level meter, the connection phase — lives in
   * here with the Room, and lifting it into the page would mean lifting the
   * Room with it. Only 'fullbleed' calls this; the framed layout has its own
   * row, unchanged.
   */
  controls?: (controls: BroadcastControls) => React.ReactNode;
  /**
   * Poll the draw loop for its frame rate, for the ?debug=camera chip.
   *
   * Off by default, and the flag exists for one honest reason: the fps number
   * moves constantly, so reading it into state re-renders this component and
   * everything it draws once a second, forever, for a readout nobody is
   * looking at. `lookMode` is not behind this flag — it is set once when the
   * pipeline opens and never changes again, so it costs nothing to always
   * have.
   */
  reportStats?: boolean;
}

/** See CreatorBroadcasterProps.presentation. */
export type BroadcastPresentation = 'framed' | 'fullbleed';

/** What a layout needs to draw its own controls. See `controls`. */
export interface BroadcastControls {
  phase: BroadcastPhase;
  /** Thai, renderable. Null while nothing is wrong. */
  error: string | null;
  retry: () => void;
  /** The room is up; whether the CDN is receiving it is the next two. */
  deliveryLive: boolean;
  deliveryError: string | null;
  micOn: boolean;
  toggleMic: () => void;
  camOn: boolean;
  toggleCamera: () => void;
  /** 0..1, polled off the local participant. For a level meter. */
  audioLevel: number;
  facing: CameraFacing;
  /** Front/back. A no-op while a previous flip is still opening a camera. */
  flipCamera: () => void;
  flippingCamera: boolean;
  /**
   * Current zoom, 1 = the full field of view the browser gave. Never an
   * implicit crop: 1 is what the native camera app shows.
   */
  zoom: number;
  setZoom: (next: number) => void;
  /** The ceiling, from the camera where it has one and 3 where it does not. */
  maxZoom: number;
  /**
   * The floor. 1 unless the camera reports a zoom range reaching below it,
   * which on a phone means a rear ultra-wide lens. Nothing can fake it.
   */
  minZoom: number;
  /** True when the camera itself is zooming, false when the canvas is. */
  hardwareZoom: boolean;
  /**
   * What the camera actually gave, as numbers: "720x1280 ar0.563 portrait".
   * Rendered in the dev bench and logged on every open — this is the thing
   * that turns "it looks zoomed" into a decision.
   */
  cameraReport: string;
  /** Set when the camera refused an upright frame; the broadcast is 16:9. */
  portraitRefused: boolean;
  /**
   * Which look implementation the publish canvas is running: 'filter' where
   * `ctx.filter` works, 'composite' where the look is rebuilt out of blend
   * passes. Null before the pipeline opens.
   *
   * Worth surfacing because the two are meant to be indistinguishable in the
   * picture — so when a look looks wrong, this is the first thing you need to
   * know and the last thing you can see.
   */
  lookMode: LookMode | null;
  /**
   * Measured draw rate of the publish canvas. 0 unless `reportStats` is on —
   * see the prop.
   */
  captureFps: number;
  /**
   * Whether to offer a screen share at all: `getDisplayMedia` exists AND this
   * is a desktop viewport. False on every phone, and false is a STATE rather
   * than a disabled button — see the note on screenShareReady.
   */
  screenShareAvailable: boolean;
  /** True while a screen share is being composited above the camera. */
  screenSharing: boolean;
  /** Start a share (the browser puts up its picker), or end the running one. */
  toggleScreenShare: () => void;
  /**
   * How the composite is arranged, and which corner the จอลอย face sits in.
   *
   * Only meaningful while `screenSharing` — the controls that set these render
   * only then — but always readable, because the choice is remembered for the
   * rest of the broadcast when a share is stopped and started again.
   */
  compositeLayout: CompositeLayout;
  pipCorner: PipCorner;
  setCompositeLayout: (layout: CompositeLayout) => void;
  setPipCorner: (corner: PipCorner) => void;
}

/**
 * The longest edge a PHONE publishes.
 *
 * The camera is asked for nothing, so it may answer with a full sensor mode —
 * 4032x3024 on a recent iPhone. That is not something to encode, push over
 * RTMP and pay a CDN for, so the filter canvas scales the whole frame down to
 * fit. 1280 keeps a 3:4 upright frame at 960x1280, which is the 720p-class
 * pixel budget the quality rungs already assume.
 */
const PHONE_MAX_LONG_EDGE = 1280;

/**
 * The zoom rungs the rail's button cycles through.
 *
 * 0.5x is offered ONLY where the camera reports a zoom capability reaching
 * below 1 — a rear ultra-wide lens on the devices that have one. It cannot be
 * faked: digital zoom crops, and there is no cropping your way to a wider
 * field of view than the sensor gave.
 */
export const ZOOM_STEPS = [1, 2, 3] as const;
export const ULTRA_WIDE_STEP = 0.5;
/** The slider's ceiling when the camera exposes no range of its own. */
export const DIGITAL_MAX_ZOOM = 3;

/**
 * Every local canvas stream, deduped.
 *
 * One on a phone, where the creator watches the same canvas the audience gets.
 * Two on desktop, where the published one is padded — and BOTH of them have to
 * hear about a mute, because the audience's copy is what actually goes silent
 * or black and the creator's copy is their only sign that it did.
 */
function localStreams(filtered: FilteredStream): MediaStream[] {
  return filtered.publishStream === filtered.previewStream
    ? [filtered.publishStream]
    : [filtered.publishStream, filtered.previewStream];
}

/**
 * Follow a LiveKit mute onto the creator's own self-view.
 *
 * The SDK mutes the PUBLISHED track, which on a padded desktop broadcast is no
 * longer the track the creator is watching — so "ปิดกล้อง" would black out the
 * audience and leave the creator looking at themselves, with nothing on screen
 * saying their camera is off. A no-op wherever the two streams are the same
 * object, which is every phone broadcast and every desktop one before this.
 */
function blankPreview(
  filtered: FilteredStream | null,
  source: Track.Source,
  enabled: boolean,
) {
  if (!filtered || filtered.publishStream === filtered.previewStream) return;
  if (source === Track.Source.Microphone) return;
  filtered.previewStream.getVideoTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

/** See screenShareReady. There is no store behind this, so nothing to unsubscribe. */
const subscribeToNothing = () => () => {};
/** The server renders no screen-share button, because there is no browser there. */
const serverHasNoScreenShare = () => false;

export function CreatorBroadcaster({
  liveSessionId,
  wsUrl,
  token,
  whipUrl,
  quality,
  delivery,
  videoDeviceId,
  micEnabled,
  elapsedSeconds,
  filterId,
  onFilterIdChange,
  orientation,
  onOrientationChange,
  viewerCount,
  reactions,
  overlay,
  onPhaseChange,
  presentation = 'framed',
  portrait = false,
  facingMode = 'user',
  onFacingModeChange,
  controls,
  reportStats = false,
}: CreatorBroadcasterProps) {
  const fullBleed = presentation === 'fullbleed';
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lookButtonRef = useRef<HTMLButtonElement | null>(null);
  const cameraButtonRef = useRef<HTMLButtonElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  /**
   * The WHIP session, on an origin broadcast. Null on the other two pipelines,
   * exactly as roomRef is null on this one — the two are alternatives, never
   * both, and every consumer below branches on `delivery` rather than on which
   * ref happens to be populated.
   */
  const whipRef = useRef<WhipSession | null>(null);
  const filteredRef = useRef<FilteredStream | null>(null);
  /**
   * The orientation the connect effect should start the canvas with.
   *
   * A ref, not a dependency: `orientation` changes while the broadcast runs,
   * and putting it in the effect's list would tear the room down and
   * reconnect every time a creator flicked a switch. The live changes go
   * through setFlipped below; this only matters for the first paint and for
   * a reconnect, which rebuilds the pipeline from scratch.
   */
  const orientationRef = useRef(orientation);
  useEffect(() => {
    orientationRef.current = orientation;
  }, [orientation]);

  /**
   * The video stream currently being drawn onto the filter canvas.
   *
   * Held separately from the camera the connect effect opened, because the
   * front/back flip replaces it: the flip opens a NEW video-only stream, points
   * the canvas at it, and stops the old one — while the ORIGINAL stream's audio
   * track keeps running, because it is the one already published. Stopping the
   * whole stream on a flip is how you end up broadcasting silence.
   */
  const sourceVideoRef = useRef<MediaStream | null>(null);
  const cameraRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<CameraFacing>(facingMode);
  const facingRef = useRef(facing);
  const [flippingCamera, setFlippingCamera] = useState(false);
  /**
   * What the camera gave us, kept so the preview can be fitted to the frame it
   * actually produced rather than to the one that was asked for.
   */
  const [camera, setCamera] = useState<CameraOpenResult | null>(null);
  /**
   * Zoom, and where it is applied.
   *
   * Per session only: state on a component that is mounted for exactly one
   * broadcast, so the next live starts at 1x. A zoom a creator forgot they
   * left on is a broadcast framed wrong from its first second.
   */
  const [zoom, setZoomState] = useState(1);
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null);
  const portraitRef = useRef(portrait);
  useEffect(() => {
    portraitRef.current = portrait;
  }, [portrait]);

  /**
   * Whether this broadcast is being run from a desktop viewport.
   *
   * null until the first capture setup answers it, and never re-read after
   * that — see the note where it is filled in. It is deliberately NOT the
   * `portrait` prop: that says which camera to open, this says how the
   * published frame is composed, and a creator on a narrow desktop window is
   * still a desktop creator to the camera and a phone one to this.
   */
  const desktopBroadcastRef = useRef<boolean | null>(null);

  /**
   * Whether this studio offers a "แชร์หน้าจอ" button at all.
   *
   * Two questions, both of which have to be yes, and NEITHER of them can be
   * answered while rendering on the server — `navigator` does not exist there
   * and `matchMedia` does not either, so this starts false and is filled in
   * after mount. A button that appeared during hydration would be a mismatch;
   * a button that appears a tick later is a button that appears.
   *
   *  - DOES THE BROWSER HAVE getDisplayMedia? Absent on iOS entirely and on
   *    macOS Safari below 13. Where it is missing there is nothing to disable:
   *    a greyed-out control is a promise that it might work later, and this
   *    one never will on that device.
   *  - IS THIS A DESKTOP VIEWPORT? The same 768px threshold the host layouts
   *    use (PRs #49, #50, #61). A phone broadcaster is holding the camera they
   *    are pointing at themselves; there is no second screen to share.
   */
  const screenShareOfferRef = useRef<boolean | null>(null);
  const readScreenShareOffer = useCallback(() => {
    // Cached on first read, because both halves of the answer are constants
    // for the life of this studio: an API is present or it is not, and a
    // creator who drags their window narrower mid-broadcast keeps the mode
    // they started in — the same rule the portrait publish frame follows.
    if (screenShareOfferRef.current === null) {
      screenShareOfferRef.current = isScreenShareSupported() && isDesktopBroadcastViewport();
    }
    return screenShareOfferRef.current;
  }, []);
  /**
   * `useSyncExternalStore` rather than state filled in by an effect, because
   * the two renders differ and React has to be told so: the server has no
   * `navigator` and must emit a row with no button, the client reads the real
   * answer, and this is the hook that lets those disagree without it being a
   * hydration mismatch. Nothing to subscribe to — the value never changes.
   */
  const screenShareReady = useSyncExternalStore(
    subscribeToNothing,
    readScreenShareOffer,
    serverHasNoScreenShare,
  );
  const [screenSharing, setScreenSharing] = useState(false);
  /**
   * How the composite is arranged, and where the จอลอย face sits.
   *
   * State for the buttons, refs for the pipeline. Both, because the two are
   * read at different times: React renders from the state, while `connect` —
   * which runs again on every rung of the reconnect ladder — needs the current
   * choice at a moment when it has no access to a render's closure. Written
   * together in the two setters below so they cannot drift.
   *
   * Per BROADCAST, not per share. Stopping a share and starting another keeps
   * the creator's arrangement, because being made to re-pick จอลอย every time
   * you pause a share is the kind of small insult that makes a studio feel
   * cheap. Nothing is written to storage, so the next broadcast starts fresh
   * at ครึ่ง-ครึ่ง.
   */
  const [compositeLayout, setCompositeLayoutState] = useState<CompositeLayout>(
    DEFAULT_COMPOSITE_LAYOUT,
  );
  const [pipCorner, setPipCornerState] = useState<PipCorner>(DEFAULT_PIP_CORNER);
  const compositeLayoutRef = useRef<CompositeLayout>(DEFAULT_COMPOSITE_LAYOUT);
  const pipCornerRef = useRef<PipCorner>(DEFAULT_PIP_CORNER);

  /**
   * Push a layout choice straight at the paint loop.
   *
   * Not an effect. An effect would land the change a render later, and this is
   * a live broadcast control — the creator presses จอลอย and the very next
   * painted frame should be จอลอย, for them and for the audience at once.
   * `filteredRef` may be null before the pipeline opens, in which case the ref
   * above carries the choice into `connect`.
   */
  const chooseCompositeLayout = useCallback((next: CompositeLayout) => {
    compositeLayoutRef.current = next;
    setCompositeLayoutState(next);
    filteredRef.current?.setCompositeLayout(next, pipCornerRef.current);
  }, []);

  const choosePipCorner = useCallback((next: PipCorner) => {
    pipCornerRef.current = next;
    setPipCornerState(next);
    filteredRef.current?.setCompositeLayout(compositeLayoutRef.current, next);
  }, []);

  /**
   * The running capture, held outside React so the teardown paths — the
   * browser's own "Stop sharing" bar, the toggle, a reconnect, unmount — can
   * all reach it without any of them being a render.
   */
  const screenShareRef = useRef<ScreenShareSession | null>(null);
  /**
   * True while the browser's picker is up.
   *
   * The picker is modal to the browser but not to the page, and it can sit
   * open for as long as a creator takes to find the right tab — long enough
   * that a second press of a button that still looks un-pressed is the
   * obvious thing to do. Without this, that second press opens a second
   * picker on top of the first.
   */
  const screenSharePendingRef = useRef(false);

  const [openMenu, setOpenMenu] = useState<'look' | 'camera' | null>(null);
  const [phase, setPhase] = useState<BroadcastPhase>('connecting');
  const [error, setError] = useState<string | null>(null);
  /**
   * Delivery to the CDN, separately from the LiveKit connection.
   *
   * They fail independently and mean different things: a creator whose room is
   * up but whose egress refused IS broadcasting — to nobody — and telling them
   * "connected" would be a lie they only discover from an empty viewer count.
   */
  const [deliveryLive, setDeliveryLive] = useState(delivery !== 'llhls');
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [lookMode, setLookMode] = useState<LookMode | null>(null);
  const [captureFps, setCaptureFps] = useState(0);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(micEnabled);
  /** Bumped by the manual "ลองใหม่", which restarts the whole connect effect. */
  const [attempt, setAttempt] = useState(0);

  const onPhaseChangeRef = useRef(onPhaseChange);
  useEffect(() => {
    onPhaseChangeRef.current = onPhaseChange;
  }, [onPhaseChange]);

  const setPhaseAndReport = useCallback((next: BroadcastPhase) => {
    setPhase(next);
    onPhaseChangeRef.current?.(next);
  }, []);

  // A look change is a variable assignment inside the draw loop, not a
  // republish — the published track is the canvas, and the canvas does not
  // care what is drawn onto it.
  useEffect(() => {
    filteredRef.current?.setFilter(filterId);
  }, [filterId]);

  // Same story for the viewer-facing flip: it is a variable in the same draw
  // loop, so turning it on mid-broadcast costs nothing and never renegotiates.
  useEffect(() => {
    filteredRef.current?.setFlipped(orientation.flipOutput);
  }, [orientation.flipOutput]);

  useEffect(() => {
    let cancelled = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let egressTimer: ReturnType<typeof setTimeout> | null = null;
    let camera: MediaStream | null = null;
    let filtered: FilteredStream | null = null;
    let whip: WhipSession | null = null;
    /**
     * Aborts a WHIP negotiation that is still in flight when the effect tears
     * down. Without it, a creator who backs out during the ~1s of ICE gathering
     * and the POST leaves a peer connection that completes into a MediaMTX path
     * nothing will ever close — and the next attempt on that path gets a 409.
     */
    const whipAbort = new AbortController();

    /**
     * The LiveKit room is not constructed at all on an origin broadcast.
     *
     * `createRoom` is cheap, but a constructed Room registers device listeners
     * and is what `roomRef` being non-null means everywhere else in this file.
     * Leaving it null on the origin path is what makes the audio meter and the
     * track toggles below branch correctly rather than silently operating on a
     * room that has nothing published to it.
     */
    const room = delivery === 'origin' ? null : createRoom(quality);
    roomRef.current = room;

    const onDisconnected = () => {
      if (cancelled) return;
      // livekit-client has already exhausted its own internal retries by the
      // time this fires, so these are full reconnects on top of that.
      if (retries >= MAX_RECONNECT_ATTEMPTS) {
        setError('ไลฟ์หลุด — การเชื่อมต่อขาดหาย');
        setPhaseAndReport('failed');
        return;
      }
      retries += 1;
      setPhaseAndReport('reconnecting');
      retryTimer = setTimeout(() => {
        if (!cancelled) void connect();
      }, RECONNECT_DELAY_MS * retries);
    };

    /**
     * Ask the backend to point a LiveKit egress at this room's Bunny stream.
     *
     * Delayed rather than immediate: the egress composites whatever is in the
     * room at the instant it starts, and catching the moment before the first
     * camera frame is published makes Bunny's opening second black. Idempotent
     * on the backend, so the reconnect path calling it again is safe.
     */
    const beginDelivery = async () => {
      if (cancelled || delivery !== 'llhls') return;

      const { error: egressError } = await startLiveEgress(
        getBrowserSupabase(),
        liveSessionId,
      );
      if (cancelled) return;

      if (egressError) {
        console.error('[CreatorBroadcaster] start egress failed', egressError);
        setDeliveryError(egressError.message);
        return;
      }
      setDeliveryError(null);
      setDeliveryLive(true);
    };

    /**
     * ICE-level recovery for the origin path, which the LiveKit path gets free.
     *
     * `livekit-client` holds a signalling socket and re-negotiates over it. A
     * WHIP publisher has one HTTP POST and then nothing — so when normal mobile
     * jitter breaks the candidate pair, the peer connection dies and the
     * broadcast ends without anyone being told. In the origin-sg-1 logs that is
     * lost RTP packets at 05:36:58 and `closed: peer connection closed` at
     * 05:37:22, with the creator's phone still showing them as live and the
     * viewer stuck on "รอสัญญาณจาก Creator".
     *
     * Two rungs, cheapest first:
     *
     *  1. ICE restart. One PATCH to the WHIP resource; the MediaMTX session and
     *     its HLS muxer survive, so viewers never see the playlist break.
     *  2. The full re-handshake ladder in onDisconnected — the same three
     *     backed-off attempts the LiveKit path uses.
     *
     * Rung 1 is bounded by the same MAX_RECONNECT_ATTEMPTS as rung 2: a
     * connection that flaps has a problem an ICE restart cannot fix, and
     * re-keying it forever would keep a broadcast nominally alive while nothing
     * reaches the origin.
     */
    let iceTimer: ReturnType<typeof setTimeout> | null = null;
    let iceRestarts = 0;
    let recovering = false;
    /**
     * A restart has been negotiated and ICE has not yet said whether it worked.
     *
     * The phase goes back to 'live' when the candidate pair actually forms, not
     * when the PATCH returns 200: a successful re-key with nothing behind it is
     * exactly the silent dead broadcast this whole path exists to stop. It also
     * keeps setPhaseAndReport off the every-event path — it notifies the parent
     * unconditionally, so 'live' is only re-sent after a real recovery.
     */
    let awaitingRestartedIce = false;

    const clearIceTimer = () => {
      if (iceTimer) clearTimeout(iceTimer);
      iceTimer = null;
    };

    const recoverWhip = async () => {
      if (cancelled || recovering) return;
      recovering = true;
      setPhaseAndReport('reconnecting');

      try {
        if (iceRestarts < MAX_RECONNECT_ATTEMPTS) {
          iceRestarts += 1;
          const restarted = await whip?.restartIce(whipAbort.signal);
          if (cancelled) return;
          if (restarted) {
            // Re-keyed against the SAME MediaMTX session, so nothing downstream
            // has to be told. Whether it took is ICE's answer, below.
            awaitingRestartedIce = true;
            /**
             * And a deadline on that answer.
             *
             * A re-keyed connection that cannot find a pair sits in `checking`,
             * which is not `disconnected` and not `failed` — so without this the
             * watcher below would match nothing and the broadcast would wait on
             * an event that never comes. Cleared the moment ICE connects.
             */
            clearIceTimer();
            iceTimer = setTimeout(() => {
              iceTimer = null;
              awaitingRestartedIce = false;
              void recoverWhip();
            }, WHIP_ICE_GRACE_MS);
            return;
          }
        }
      } finally {
        recovering = false;
      }

      if (!cancelled) onDisconnected();
    };

    const watchWhipConnection = (pc: RTCPeerConnection) => {
      const onStateChange = () => {
        if (cancelled) return;
        const ice = pc.iceConnectionState;
        const connection = pc.connectionState;

        // ICE is the finer signal and the one that clears first, so it decides
        // that the broadcast is healthy again — including after a restart,
        // which walks back through `checking` and matches nothing below.
        if (ice === 'connected' || ice === 'completed') {
          clearIceTimer();
          if (awaitingRestartedIce) {
            awaitingRestartedIce = false;
            setPhaseAndReport('live');
          }
          return;
        }

        // Nothing to restart on a closed connection; only a new one will do.
        if (connection === 'closed' || ice === 'closed') {
          clearIceTimer();
          onDisconnected();
          return;
        }

        if (connection === 'failed' || ice === 'failed') {
          clearIceTimer();
          awaitingRestartedIce = false;
          void recoverWhip();
          return;
        }

        /**
         * `disconnected` is given a grace window rather than acted on.
         *
         * It is the state a phone passes through on a cell handover and it
         * clears itself within a second or two, so rescuing it immediately
         * would turn every lift ride into a visible reconnect. Waiting forever
         * is what shipped, and what let a three-second airplane-mode blip end a
         * broadcast. See WHIP_ICE_GRACE_MS.
         */
        if ((connection === 'disconnected' || ice === 'disconnected') && !iceTimer) {
          iceTimer = setTimeout(() => {
            iceTimer = null;
            void recoverWhip();
          }, WHIP_ICE_GRACE_MS);
        }
      };

      pc.addEventListener('connectionstatechange', onStateChange);
      pc.addEventListener('iceconnectionstatechange', onStateChange);
    };

    async function connect() {
      setError(null);
      setPhaseAndReport(retries === 0 ? 'connecting' : 'reconnecting');

      // The camera is opened once and reused across reconnects. Re-opening it
      // per attempt is how you hit "camera is in use by another application"
      // on Windows Chrome, which holds a device briefly after release.
      if (!camera) {
        try {
          // On a phone this asks for NOTHING but the facing and the frame
          // rate: every size or ratio hint is read by iOS as permission to
          // crop its 4:3 sensor, which is the 2x telephoto view a creator
          // reported at 1x. Desktop still asks for its quality rung. See
          // lib/live/cameraCapture.ts.
          const opened = await openCamera({
            quality,
            portrait: portraitRef.current,
            deviceId: videoDeviceId,
            facingMode: videoDeviceId ? null : facingRef.current,
            audio: true,
          });
          camera = opened.stream;
          cameraRef.current = camera;
          sourceVideoRef.current = camera;
          if (!cancelled) {
            setCamera(opened);
            setZoomRange(hardwareZoomRange(camera.getVideoTracks()[0]));
          }
        } catch (err) {
          if (cancelled) return;
          console.error('[CreatorBroadcaster] getUserMedia failed', err);
          setError(thaiForMediaError(err));
          setPhaseAndReport('failed');
          return;
        }
      }

      if (!filtered) {
        /**
         * Desktop or phone, decided once for the life of this broadcast.
         *
         * Cached in a ref rather than read here every time, because `connect`
         * runs again on every rung of the reconnect ladder: a creator who
         * resized their window mid-broadcast must not come back from a blip
         * with a differently framed picture.
         */
        if (desktopBroadcastRef.current === null) {
          desktopBroadcastRef.current = isDesktopBroadcastViewport();
        }

        try {
          filtered = await createFilteredStream(
            camera,
            filterId,
            resolutionFor(quality).frameRate,
            orientationRef.current.flipOutput,
            // Phone only. A camera asked for nothing hands back a full sensor
            // mode; the whole frame is scaled down to fit, ratio intact, never
            // cropped. Desktop passes nothing and is unchanged — a 1080p rung
            // must still publish 1920x1080.
            portraitRef.current ? PHONE_MAX_LONG_EDGE : undefined,
            // Desktop only, and it changes what the AUDIENCE gets, not what
            // the creator sees: the published canvas is a fixed portrait frame
            // that the 16:9 webcam COVERS, so a phone viewer gets a face edge
            // to edge instead of a small one in a field of black. The preview
            // stays the full un-cropped webcam frame.
            desktopBroadcastRef.current === true,
            /*
              HOW BIG THAT PUBLISHED FRAME IS — and the whole of what makes
              1080p real rather than a label.

              720x1280 at every rung but 1080p, where it is 1080x1920. The
              camera above was already asked for the rung's own resolution
              (resolutionFor: 1920x1080 at 1080p), so without this the extra
              sensor detail was being downscaled straight back into a 720-wide
              canvas and published under a 9 Mbps ceiling — more bits for
              exactly the same picture, which is worse than not offering the
              option at all.
            */
            compositeSizeFor(quality),
          );
          filteredRef.current = filtered;
          // The arrangement the creator last chose, carried across a
          // reconnect. A fresh pipeline starts at the defaults, so without
          // this a blip would silently put a creator back in ครึ่ง-ครึ่ง.
          filtered.setCompositeLayout(compositeLayoutRef.current, pipCornerRef.current);
          setLookMode(filtered.getStats().lookMode);
        } catch (err) {
          if (cancelled) return;
          console.error('[CreatorBroadcaster] filter pipeline failed', err);
          setError('เปิดฟิลเตอร์กล้องไม่สำเร็จ กรุณาลองใหม่');
          setPhaseAndReport('failed');
          return;
        }
      }

      // The self-view shows the CANVAS, not the camera — so what the creator
      // is looking at is the frames the audience receives, filter included.
      // The PREVIEW canvas, specifically: on desktop the published one has the
      // same picture drawn smaller with black around it, and a creator framing
      // a shot needs their own full frame, not the padded one. Muted is not a
      // preference: an unmuted self-view is a feedback loop.
      if (videoRef.current) {
        videoRef.current.srcObject = filtered.previewStream;
        videoRef.current.muted = true;
        void videoRef.current.play().catch(() => {});
      }

      /**
       * The one place the three pipelines actually diverge.
       *
       * Everything above — the camera, the filter canvas, the self-view, the
       * iOS framing fix — is shared, because what is being published is
       * identical in all three cases: the canvas. Only the transport differs,
       * and it differs completely: a LiveKit room with a token, or one HTTP
       * POST carrying an SDP offer.
       */
      try {
        if (delivery === 'origin') {
          /**
           * Retire the previous session BEFORE opening a new one.
           *
           * MediaMTX admits one publisher per path and keeps the loser waiting:
           * a re-handshake that leaves the old peer connection standing gets a
           * 409, which surfaces to the creator as "ไลฟ์ก่อนหน้ายังปิดไม่สมบูรณ์"
           * and burns a rung of the ladder every time. The deploy runbook
           * records the same failure for a missed teardown route. Awaited, so
           * the DELETE has actually landed before the POST goes out.
           */
          if (whip) {
            const previous = whip;
            whip = null;
            whipRef.current = null;
            clearIceTimer();
            await previous.close();
            if (cancelled) return;
          }

          whip = await publishWhip({
            endpoint: whipUrl,
            stream: filtered.publishStream,
            quality,
            micEnabled,
            /**
             * The rate the canvas is ACTUALLY painted at, which is a
             * function of the mode — 24 while a screen share is being
             * composited in, the camera's 30 otherwise (see
             * COMPOSITE_FRAME_RATE). Read from the ref rather than from
             * React state because this runs on every rung of the reconnect
             * ladder: a creator whose connection blipped mid-share must come
             * back with the cap their composite needs, not the one a fresh
             * broadcast would get.
             */
            maxFramerate: screenShareRef.current
              ? COMPOSITE_FRAME_RATE
              : resolutionFor(quality).frameRate,
            signal: whipAbort.signal,
          });
          whipRef.current = whip;

          /**
           * WHIP has no reconnect of its own — there is no SDK holding a
           * signalling socket, so nothing retries unless this does. The peer
           * connection's own state is the only signal that the broadcast has
           * dropped, and the last rung is the SAME ladder the LiveKit path
           * uses so both pipelines fail over identically.
           *
           * BOTH state events are listened to, not one. The connection state is
           * the aggregate (ICE plus DTLS) and is what Chrome moves first; the
           * ICE state is what Safari reports promptly while its connection
           * state lags. A publisher that watches only one of them recovers on
           * one browser and hangs on the other.
           */
          watchWhipConnection(whip.pc);
        } else {
          await connectAsPublisher(room!, {
            wsUrl,
            token,
            quality,
            stream: filtered.publishStream,
            micEnabled,
            delivery,
          });
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[CreatorBroadcaster] connect failed', err);
        setError(delivery === 'origin' ? thaiForWhipError(err) : thaiForConnectError(err));
        setPhaseAndReport('failed');
        return;
      }
      if (cancelled) return;

      retries = 0;
      setCamOn(true);
      setMicOn(micEnabled);
      setPhaseAndReport('live');

      egressTimer = setTimeout(() => void beginDelivery(), EGRESS_START_DELAY_MS);

      // A backstop only: start_egress promotes the row server-side. It still
      // matters for a session delivered over LiveKit, where no egress starts
      // and so nothing else would move it off 'waiting'.
      try {
        await markSessionLive(getBrowserSupabase(), liveSessionId);
      } catch (err) {
        console.error('[CreatorBroadcaster] markSessionLive failed', err);
      }
    }

    const onReconnecting = () => setPhaseAndReport('reconnecting');
    const onReconnected = () => setPhaseAndReport('live');

    // No room on the origin path, so no room events: its equivalent is the peer
    // connection's `connectionstatechange`, wired inside connect() above.
    room?.on(RoomEvent.Reconnecting, onReconnecting);
    room?.on(RoomEvent.Reconnected, onReconnected);
    room?.on(RoomEvent.Disconnected, onDisconnected);

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (egressTimer) clearTimeout(egressTimer);
      clearIceTimer();
      // Each handler is removed by reference rather than with
      // removeAllListeners(): the Room is an EventEmitter the SDK also hands
      // to its own internals, and tearing down every listener on it is a
      // bigger hammer than unsubscribing what this component subscribed.
      room?.off(RoomEvent.Reconnecting, onReconnecting);
      room?.off(RoomEvent.Reconnected, onReconnected);
      room?.off(RoomEvent.Disconnected, onDisconnected);
      roomRef.current = null;
      whipRef.current = null;
      filteredRef.current = null;
      if (room) void leaveRoom(room);
      // Aborts a negotiation still in flight; closes one that completed. Both
      // are needed — see whipAbort above for the session this would otherwise
      // strand on the origin box.
      whipAbort.abort();
      void whip?.close();
      /*
        A screen share does not survive the pipeline it was composited into.

        This teardown runs when the broadcast is rebuilt from scratch — a
        manual retry, a delivery change, unmount — and the new pipeline starts
        camera-only with no source mounted. Leaving the capture running would
        put the studio's toggle and the browser's stop bar into disagreement
        about what is being broadcast, with the browser telling the truth.
      */
      screenShareRef.current?.stop();
      screenShareRef.current = null;
      setScreenSharing(false);
      // The arrangement is per-broadcast and this is where a broadcast ends.
      // Deliberately NOT reset when a share merely stops — see the state above.
      compositeLayoutRef.current = DEFAULT_COMPOSITE_LAYOUT;
      pipCornerRef.current = DEFAULT_PIP_CORNER;
      setCompositeLayoutState(DEFAULT_COMPOSITE_LAYOUT);
      setPipCornerState(DEFAULT_PIP_CORNER);
      // Order matters: the filter stops its draw loop and its canvas track,
      // then the camera itself is released. Stopping the camera first leaves
      // the loop drawing a dead <video>.
      filtered?.stop();
      camera?.getTracks().forEach((track) => track.stop());
      // The flip may have swapped in a different camera since; that one is not
      // `camera` and would otherwise be left holding the device.
      const swapped = sourceVideoRef.current;
      if (swapped && swapped !== camera) swapped.getTracks().forEach((track) => track.stop());
      cameraRef.current = null;
      sourceVideoRef.current = null;
    };
    // micEnabled and filterId are the STARTING values only — both are changed
    // afterwards through the controls below, not through a reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessionId, wsUrl, token, whipUrl, quality, videoDeviceId, delivery, attempt]);

  /**
   * Write the audience size back to the row.
   *
   * The number comes from the Realtime channel's presence, which is the only
   * thing that knows it now that viewers are not room participants.
   * live-end-session reads the resulting peak to build the summary and price
   * the broadcast, so without this every session reports zero viewers and
   * bills as if nobody watched.
   */
  useEffect(() => {
    if (phase !== 'live') return;

    const write = () => {
      void persistViewerCounts(getBrowserSupabase(), liveSessionId, viewerCount).catch((err) => {
        console.error('[CreatorBroadcaster] persist counts failed', err);
      });
    };

    write();
    const timer = setInterval(write, VIEWER_PERSIST_MS);
    return () => clearInterval(timer);
  }, [phase, liveSessionId, viewerCount]);

  /**
   * The publish canvas's own frame rate, while someone is watching the chip.
   *
   * One second, not 250ms like the level meter: a frame rate averaged over a
   * second IS a once-a-second number, and sampling it four times as often
   * would re-render four times as much to show the same value.
   */
  useEffect(() => {
    if (!reportStats) return;
    const timer = setInterval(() => {
      setCaptureFps(filteredRef.current?.getStats().fps ?? 0);
    }, 1000);
    return () => clearInterval(timer);
  }, [reportStats]);

  /**
   * The bottom-left level meter.
   *
   * Two implementations, because the number has two possible sources. On the
   * LiveKit path the SDK already computes it and it is a property read. On the
   * origin path there is no SDK, so it is measured here off the published
   * stream with an AnalyserNode — the alternative was leaving the meter pinned
   * at zero, which does not read as "no source of data", it reads as "your
   * microphone is dead" on the one screen a creator checks before speaking.
   */
  useEffect(() => {
    if (phase !== 'live') return;

    if (delivery !== 'origin') {
      const timer = setInterval(() => {
        setAudioLevel(roomRef.current?.localParticipant.audioLevel ?? 0);
      }, 250);
      return () => clearInterval(timer);
    }

    // The published stream: it is the one carrying the microphone. The preview
    // canvas is video only — a self-view is muted by definition.
    const stream = filteredRef.current?.publishStream;
    const audioTrack = stream?.getAudioTracks()[0];
    if (!audioTrack) return;

    // Safari still only has the prefixed constructor on some versions this
    // product targets, and a missing AudioContext must cost the meter, not the
    // broadcast.
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;

    let context: AudioContext;
    try {
      context = new AudioCtor();
    } catch (err) {
      console.warn('[CreatorBroadcaster] no AudioContext for the level meter', err);
      return;
    }

    const analyser = context.createAnalyser();
    // Small window, no smoothing of our own: the meter is redrawn four times a
    // second and an averaged-over-seconds level looks laggy against speech.
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    const source = context.createMediaStreamSource(new MediaStream([audioTrack]));
    source.connect(analyser);
    // NOT connected to context.destination: routing the creator's own mic to
    // their speakers is a feedback loop, and the analyser taps the signal
    // without needing an output.

    const samples = new Uint8Array(analyser.frequencyBinCount);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      // RMS around the 128 midpoint, scaled to roughly the 0-1 range LiveKit's
      // audioLevel reports so the same bar renders the same way on both paths.
      let sum = 0;
      for (const sample of samples) {
        const centred = (sample - 128) / 128;
        sum += centred * centred;
      }
      setAudioLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3));
    }, 250);

    return () => {
      clearInterval(timer);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(() => {});
    };
  }, [phase, delivery]);

  /**
   * Camera and mic are toggled by MUTING the publication, not by unpublishing.
   *
   * Unpublishing would renegotiate, and the egress composites the room live —
   * a track that comes and goes makes Bunny's ingest reconnect, which every
   * viewer sees as a stall. A muted track keeps the connection and sends
   * black or silence, which is what "camera off" should look like anyway.
   */
  const toggleTrack = async (source: Track.Source, next: boolean) => {
    /**
     * On the origin path there is no publication to mute — WHIP publishes raw
     * MediaStreamTracks with no SDK wrapping them — so the equivalent is
     * `track.enabled`, which is what LiveKit's own mute() sets underneath.
     *
     * The property matters more than the parity: a disabled track keeps sending
     * (black frames, silent audio) rather than stopping, so the encoder and the
     * RTP stream stay up and MediaMTX never sees the publisher go away. Stopping
     * the track instead would end the broadcast, which is emphatically not what
     * "camera off" means.
     */
    if (delivery === 'origin') {
      const filtered = filteredRef.current;
      if (!filtered) return;
      for (const stream of localStreams(filtered)) {
        const tracks =
          source === Track.Source.Microphone ? stream.getAudioTracks() : stream.getVideoTracks();
        tracks.forEach((track) => {
          track.enabled = next;
        });
      }
      return;
    }

    const publication = localPublication(roomRef.current, source);
    if (!publication) return;
    try {
      if (next) await publication.unmute();
      else await publication.mute();
      blankPreview(filteredRef.current, source, next);
    } catch (err) {
      console.error('[CreatorBroadcaster] toggle track failed', err);
    }
  };

  const toggleCamera = async () => {
    const next = !camOn;
    await toggleTrack(Track.Source.Camera, next);
    setCamOn(next);
  };

  const toggleMic = async () => {
    const next = !micOn;
    await toggleTrack(Track.Source.Microphone, next);
    setMicOn(next);
  };

  /**
   * Front camera to back camera, and back, WITHOUT republishing anything.
   *
   * The published track is the filter canvas, so switching cameras is a matter
   * of pointing that canvas at a different source: `setSource` swaps the
   * detached <video>'s srcObject and the very next frame is drawn from the new
   * camera. LiveKit never renegotiates, the egress never notices, and Bunny's
   * ingest never reconnects — which matters, because a renegotiation mid-
   * broadcast is a visible stall for every viewer.
   *
   * `audio: false` is load-bearing: the mic already publishing belongs to the
   * stream opened at connect time, and asking for a second one here would
   * either fail or leave two microphones open.
   */
  const flipCamera = useCallback(async () => {
    const filtered = filteredRef.current;
    if (!filtered || flippingCamera) return;

    const next: CameraFacing = facingRef.current === 'user' ? 'environment' : 'user';
    setFlippingCamera(true);
    try {
      const opened = await openCamera({
        quality,
        portrait: portraitRef.current,
        facingMode: next,
        audio: false,
      });

      const previous = sourceVideoRef.current;
      await filtered.setSource(opened.stream);
      sourceVideoRef.current = opened.stream;
      setCamera(opened);
      // The new camera has its own zoom range — a back camera often zooms
      // where a front one does not — so the range is re-read rather than
      // carried over, and the level is reset to the honest 1x.
      setZoomRange(hardwareZoomRange(opened.stream.getVideoTracks()[0]));
      setZoomState(1);
      filtered.setZoom(1);

      // Only the VIDEO tracks of the old source, and only once the new one is
      // drawing: the original stream's audio track is the published mic.
      previous?.getVideoTracks().forEach((track) => track.stop());

      facingRef.current = next;
      setFacing(next);
      onFacingModeChange?.(next);
    } catch (err) {
      // A phone with one camera, or a permission the creator revoked. The
      // broadcast is unaffected — it is still drawing the camera it had — so
      // this is logged, not surfaced as a broadcast error.
      console.error('[CreatorBroadcaster] flip camera failed', err);
    } finally {
      setFlippingCamera(false);
    }
  }, [flippingCamera, quality, onFacingModeChange]);


  /**
   * Put the studio back to camera-only, whoever asked for it.
   *
   * The ONE fallback path, because there are three ways into it and they must
   * not disagree: the creator presses the toggle again, the creator presses
   * Chrome's floating "Stop sharing" bar, or the broadcast tears down and
   * rebuilds. `stopCapture` is false for the second of those — the browser has
   * already ended the source and calling stop() on it would be a no-op with a
   * misleading log line.
   *
   * The broadcast does not move. Composite off is a flag inside the draw loop
   * (see setSecondSource), so the canvas keeps painting, the track keeps
   * flowing, the peer connection is untouched and no viewer reconnects — the
   * picture simply becomes the camera again on the next frame.
   */
  const endScreenShare = useCallback((stopCapture: boolean) => {
    const session = screenShareRef.current;
    screenShareRef.current = null;
    if (stopCapture) session?.stop();
    void filteredRef.current?.setSecondSource(null);
    /**
     * The encoder's cap follows the canvas back up to 30.
     *
     * In-band on the live session — no renegotiation, nothing a viewer sees
     * (see WhipSession.setMaxFramerate). Fire-and-forget because it cannot
     * fail in a way worth handling: the worst case is an encoder still capped
     * at 24 on a canvas painting 30, which is a slightly smoother picture than
     * yesterday rather than a broken one.
     */
    void whipRef.current?.setMaxFramerate(resolutionFor(quality).frameRate);
    setScreenSharing(false);
  }, [quality]);

  /**
   * Share a screen, or stop sharing one.
   *
   * DELIBERATELY NOT RECOVERABLE. If the source goes away — the tab is closed,
   * the window is quit, the creator presses the browser's stop bar — this
   * falls back to the camera and stays there until someone asks again.
   * Re-opening the picker on the creator's behalf would be an app deciding to
   * broadcast a screen that nobody chose, and re-opening it without the picker
   * is not something the platform allows for exactly that reason.
   *
   * Nor is the choice remembered: every broadcast starts camera-only. A
   * creator who shared a chart last Tuesday and has forgotten about it is one
   * click from streaming whatever is on their screen now.
   */
  const toggleScreenShare = useCallback(async () => {
    if (screenShareRef.current) {
      endScreenShare(true);
      return;
    }
    if (screenSharePendingRef.current) return;

    const filtered = filteredRef.current;
    if (!filtered) return;

    let session: ScreenShareSession | null = null;
    screenSharePendingRef.current = true;
    try {
      // The picker is the browser's, and dismissing it resolves to null —
      // which must leave the studio exactly as it was: no error, no state
      // change, no button stuck looking pressed.
      // The rung decides how large a capture to ask the browser for: 1280x720
      // at 720p, 1920x1080 at 1080p. A 720p capture drawn into a 1080-wide
      // slot would be an upscaled chart, which is the one outcome this whole
      // change exists to avoid — see screenCaptureCapFor.
      session = await startScreenShare(() => endScreenShare(false), quality);
    } catch (err) {
      // A policy or an extension refused. The broadcast is unaffected, so this
      // is logged rather than raised as a broadcast error the way a camera
      // failure is — the creator is still live, just not sharing.
      console.error('[screen] could not start a share', err);
      return;
    } finally {
      screenSharePendingRef.current = false;
    }
    if (!session) return;

    // The pipeline may have been torn down during the seconds the picker was
    // open — a reconnect, or the creator ending the live. Publishing into a
    // dead canvas is not possible, so the capture is released instead of left
    // running with Chrome's bar on screen and nothing behind it.
    const target = filteredRef.current;
    if (!target) {
      session.stop();
      return;
    }

    screenShareRef.current = session;
    try {
      // `contain`, explicitly: a shared chart cropped to fill the slot loses
      // its price axis off one side and its time axis off the other. The
      // mobile back camera passes 'cover' instead — see toggleDualCamera.
      await target.setSecondSource(session.stream, { fit: 'contain', kind: 'screen' });
      // The composite paints at 24 from the line above; this is the encoder
      // being told the same thing. Capping it is what makes a frame the
      // encoder cannot finish in time a DROPPED frame rather than a queued
      // one — a queue is the multi-second lag Por recorded, and it is the one
      // failure mode no amount of bitrate can fix.
      void whipRef.current?.setMaxFramerate(COMPOSITE_FRAME_RATE);
    } catch (err) {
      console.error('[composite] could not mount the screen source', err);
      endScreenShare(true);
      return;
    }
    setScreenSharing(true);
  }, [endScreenShare, quality]);

  /**
   * Never leave a capture running behind a studio that is gone.
   *
   * Chrome's "Stop sharing" bar outlives the page that opened it if the track
   * is not stopped, and a creator who ended their live and is looking at a
   * summary screen while the browser insists they are still sharing their
   * desktop is a privacy problem, not an untidy one.
   */
  useEffect(() => {
    return () => {
      screenShareRef.current?.stop();
      screenShareRef.current = null;
    };
  }, []);

  // The self-view is the canvas, so the output flip is already in these
  // frames — which is exactly why the creator's own preference cannot be read
  // off `mirrorPreview` alone.
  /**
   * Put a zoom level into effect, on whichever mechanism this camera has.
   *
   * HARDWARE FIRST, ALWAYS. A camera that can zoom itself keeps the sensor's
   * full resolution; the canvas crop throws pixels away to reach the same
   * framing. So the constraint is tried first and the canvas is left at 1
   * whenever it lands, and only a camera with no zoom capability — or one that
   * refuses the constraint — falls through to cropping.
   *
   * Either way the creator's self-view and the published frames agree, because
   * both are the same canvas fed by the same track.
   */
  const applyZoom = useCallback(
    async (next: number) => {
      // Below 1 only where the camera itself goes there: the canvas can crop
      // in, never out.
      const floor = zoomRange && zoomRange.min < 1 ? zoomRange.min : 1;
      const clamped = Math.max(floor, Math.min(zoomRange?.max ?? DIGITAL_MAX_ZOOM, next));
      setZoomState(clamped);

      const track = sourceVideoRef.current?.getVideoTracks()[0];
      if (zoomRange) {
        const applied = await applyZoomConstraint(track, clamped, zoomRange);
        if (applied) {
          filteredRef.current?.setZoom(1);
          return;
        }
        // It said it could and then would not. Fall through rather than
        // leaving the creator with a control that does nothing.
      }
      filteredRef.current?.setZoom(clamped);
    },
    [zoomRange],
  );

  const previewFlipped = shouldFlipPreview(orientation.mirrorPreview, orientation.flipOutput);

  /*
    HOW THE SELF-VIEW IS FITTED, and why it is not always `cover`.

    `cover` fills a portrait phone with a portrait camera, which is the point.
    Point it at a LANDSCAPE track — a camera that refused an upright frame —
    and it crops away about two thirds of the width, which is most of the
    reported zoom. So the fit follows what the camera ACTUALLY gave: cover
    while the source is upright, contain the moment it is not.

    The creator then sees letterboxing that a phone viewer will not (the
    viewer's player covers, by design). That is the correct trade: the host
    screen's job is to show the framing being published, and a host who cannot
    see their own edges cannot frame anything.
  */
  const sourceIsLandscape = camera?.orientation === 'landscape';

  /*
    THE PHONE HOST LAYOUT.

    The self-view is the viewport — `fixed inset-0` at 100vw x 100dvh, z-0
    under the page's chrome — and `object-cover`, so a portrait camera fills a
    portrait phone edge to edge. Same box, same reasoning and the same z-order
    as the viewer's full-bleed player; see HlsLivePlayer.

    Everything else this component draws in 'framed' — the pills, the level
    meter, the control row — is the PAGE's here, and reaches it through
    `controls`. That is not tidiness: the control row is where "จบไลฟ์" lived,
    and on a squeezed-down desktop studio it wrapped off the bottom of a phone
    screen and left the creator unable to end their own broadcast.
  */
  if (fullBleed) {
    return (
      <>
        <div className="fixed inset-0 z-0 h-[100dvh] w-screen overflow-hidden bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            aria-label="ภาพที่กำลังถ่ายทอด"
            className={[
              'absolute inset-0 h-full w-full',
              sourceIsLandscape ? 'object-contain' : 'object-cover',
              previewFlipped ? 'scale-x-[-1]' : '',
            ].join(' ')}
          />
          <FloatingReactionsLayer reactions={reactions} />
          {overlay}
          {phase !== 'live' && (
            <ConnectionOverlay
              phase={phase}
              error={error}
              onRetry={() => setAttempt((n) => n + 1)}
              fullBleed
            />
          )}
        </div>
        {/*
          eslint-disable-next-line react-hooks/refs -- Every value below is
          useState, not a ref: phase, error, deliveryLive, deliveryError,
          micOn, camOn, audioLevel, facing and flippingCamera are all state,
          and the four callbacks are passed, never invoked, here. The rule
          fires because those callbacks close over roomRef and filteredRef and
          it cannot see that they are only ever called from an event handler.
        */}
        {controls?.({
          phase,
          error,
          retry: () => setAttempt((n) => n + 1),
          deliveryLive,
          deliveryError,
          micOn,
          toggleMic: () => void toggleMic(),
          camOn,
          toggleCamera: () => void toggleCamera(),
          audioLevel,
          facing,
          flipCamera: () => void flipCamera(),
          flippingCamera,
          zoom,
          setZoom: (next: number) => void applyZoom(next),
          maxZoom: zoomRange?.max ?? DIGITAL_MAX_ZOOM,
          minZoom: zoomRange && zoomRange.min < 1 ? zoomRange.min : 1,
          hardwareZoom: zoomRange !== null,
          cameraReport: describeCamera(camera),
          portraitRefused: camera?.portraitRefused === true,
          lookMode,
          captureFps,
          screenShareAvailable: screenShareReady,
          screenSharing,
          toggleScreenShare: () => void toggleScreenShare(),
          compositeLayout,
          pipCorner,
          setCompositeLayout: chooseCompositeLayout,
          setPipCorner: choosePipCorner,
        })}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-black">
        {/* No CSS filter on this element any more. The look is already in the
            pixels — this is the canvas stream, which is what the encoder, the
            egress, Bunny and every viewer receive.

            The transform is the one thing that is still local. It exists so
            the two switches stay independent: the frames here may already be
            flipped for viewers, and the creator's preference about their own
            preview has to survive that. shouldFlipPreview works out which
            way round this element has to be for both to hold at once. */}
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label="ภาพที่กำลังถ่ายทอด"
          className={[
            'h-full w-full object-contain',
            previewFlipped ? 'scale-x-[-1]' : '',
          ].join(' ')}
        />

        <FloatingReactionsLayer reactions={reactions} />
        {overlay}

        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2">
          <LiveBadge pulse={phase === 'live'} />
          {phase === 'live' && !deliveryLive && (
            <span className="rounded-full bg-amber-500/85 px-2.5 py-1 text-[11px] font-semibold text-black">
              กำลังเริ่มส่งสัญญาณ...
            </span>
          )}
        </div>

        <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2">
          <ViewerCountPill count={viewerCount} />
          <DurationPill seconds={elapsedSeconds} />
        </div>

        {/* Audio level, bottom-left. Sits over the video rather than beside it
            so a creator watching their own framing sees it without looking
            away. */}
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-full bg-black/55 px-2.5 py-1.5 backdrop-blur-sm">
          {micOn ? (
            <Mic size={13} className="text-white" aria-hidden />
          ) : (
            <MicOff size={13} className="text-rose-300" aria-hidden />
          )}
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/20">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-cyan-400 to-purple-400 transition-[width] duration-150"
              style={{ width: `${micOn ? Math.round(Math.min(1, audioLevel * 3) * 100) : 0}%` }}
            />
          </span>
        </div>

        {phase !== 'live' && <ConnectionOverlay phase={phase} error={error} onRetry={() => setAttempt((n) => n + 1)} />}
      </div>

      {/* Delivery failed but the room is up. Said out loud rather than left to
          be inferred from a viewer count that never moves. */}
      {deliveryError && phase === 'live' && (
        <div
          role="alert"
          className="shrink-0 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100"
        >
          {deliveryError} — ผู้ชมยังดูไม่ได้ในขณะนี้
        </div>
      )}

      {/*
        The control row, and the panel that opens above it.

        The panel is anchored to the ROW rather than to the button that opened
        it, which is what lets it be a full-width sheet on a phone and a 22rem
        dropdown on a desktop from one piece of markup. Anchored to the button
        instead, a 22rem panel hanging off the third control in the row runs
        straight off a 360px screen.

        flex-wrap because the row carries four controls plus the quality pill,
        and on a desktop mid-share two more groups on top of that — the layout
        segments and, under จอลอย, the corner picker. They wrap onto a second
        line rather than squeezing past the edge.
      */}
      <div
        className="relative flex shrink-0 flex-wrap items-center gap-2"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !openMenu) return;
          const trigger = openMenu === 'look' ? lookButtonRef : cameraButtonRef;
          setOpenMenu(null);
          trigger.current?.focus();
        }}
      >
        {openMenu && (
          <>
            {/* A transparent full-screen catcher rather than a document
                listener: the bottom bar is the last thing between a creator
                and "จบไลฟ์", and a stray listener that outlives this popover
                would sit over that button.

                The trigger buttons are lifted above it (z-50) so that tapping
                the other menu switches to it in one tap instead of spending
                the first tap dismissing this. */}
            <button
              type="button"
              aria-label={openMenu === 'look' ? 'ปิดตัวเลือกลุค' : 'ปิดตัวเลือกกล้อง'}
              onClick={() => setOpenMenu(null)}
              className="fixed inset-0 z-30 cursor-default"
            />
            <div className="absolute bottom-full left-0 z-40 mb-2 w-full rounded-2xl border border-white/10 bg-[#0c101b] p-4 shadow-2xl shadow-black/60 sm:w-[min(22rem,80vw)]">
              {openMenu === 'look' ? (
                // Stays open after a choice: picking a look is comparing
                // looks, and a popover that closes on the first tap makes
                // trying the next one a second trip to the bottom bar.
                <CameraFilterSelector value={filterId} onChange={onFilterIdChange} />
              ) : (
                <CameraControlsMenu value={orientation} onChange={onOrientationChange} />
              )}
            </div>
          </>
        )}

        <ControlButton
          onClick={toggleMic}
          active={micOn}
          label={micOn ? 'ปิดไมโครโฟน' : 'เปิดไมโครโฟน'}
          icon={micOn ? <Mic size={18} aria-hidden /> : <MicOff size={18} aria-hidden />}
        />
        <ControlButton
          onClick={toggleCamera}
          active={camOn}
          label={camOn ? 'ปิดกล้อง' : 'เปิดกล้อง'}
          icon={camOn ? <Video size={18} aria-hidden /> : <VideoOff size={18} aria-hidden />}
        />

        <MenuButton
          ref={lookButtonRef}
          open={openMenu === 'look'}
          onToggle={() => setOpenMenu((current) => (current === 'look' ? null : 'look'))}
          icon={<Sparkles size={16} aria-hidden />}
          label="เลือกลุค"
          value={filterLabelFor(filterId)}
        />
        {/*
          "แชร์หน้าจอ", and it is ABSENT rather than disabled where it cannot
          work — see screenShareReady. On a phone, and on any browser without
          getDisplayMedia, this row is exactly what it was before this feature.
        */}
        {screenShareReady && (
          <ToggleButton
            onClick={() => void toggleScreenShare()}
            active={screenSharing}
            icon={
              screenSharing ? (
                <ScreenShareOff size={16} aria-hidden />
              ) : (
                <ScreenShare size={16} aria-hidden />
              )
            }
            label={screenSharing ? 'หยุดแชร์หน้าจอ' : 'แชร์หน้าจอ'}
          />
        )}
        {/*
          HOW THE SHARE AND THE FACE ARE ARRANGED.

          Present only while a share is actually running, and gated on the same
          screenShareReady as the button above it: with nothing shared there is
          no arrangement to make, and three dead buttons in the bottom bar of a
          phone studio is three buttons of clutter explaining a feature that
          screen has no way to offer.

          Not in the ลุค/กล้อง popover with the other pickers, deliberately.
          Those are set-and-forget; this is watched. A creator picking จอลอย is
          looking at the preview to see where they land, and a panel covering
          the preview is a panel covering the thing being decided.
        */}
        {screenShareReady && screenSharing && (
          <div
            role="radiogroup"
            aria-label="รูปแบบการจัดวาง"
            className="inline-flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-1"
          >
            {COMPOSITE_LAYOUT_ORDER.map((layout) => (
              <button
                key={layout}
                type="button"
                role="radio"
                aria-checked={compositeLayout === layout}
                onClick={() => chooseCompositeLayout(layout)}
                className={[
                  'relative z-50 inline-flex min-h-9 items-center rounded-lg px-2.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
                  compositeLayout === layout
                    ? 'bg-cyan-400/20 text-cyan-100'
                    : 'text-white/65 hover:bg-white/[0.06] hover:text-white/85',
                ].join(' ')}
              >
                {COMPOSITE_LAYOUT_LABELS[layout]}
              </button>
            ))}
          </div>
        )}
        {/*
          WHICH CORNER THE จอลอย FACE SITS IN.

          Four buttons rather than a drag handle, and that is the whole scope:
          a creator needs their face off whatever the share is putting in that
          corner, which four presets answer completely. Free-drag on a canvas
          is a different feature — pointer capture, bounds, a preview that has
          to hit-test — and it is not this one.

          Only under จอลอย, because a corner is a property of a floating face
          and the other two layouts have nowhere to put it.
        */}
        {screenShareReady && screenSharing && compositeLayout === 'pip' && (
          <div
            role="radiogroup"
            aria-label="ตำแหน่งภาพลอย"
            className="inline-flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-1"
          >
            {PIP_CORNER_ORDER.map((corner) => (
              <button
                key={corner}
                type="button"
                role="radio"
                aria-checked={pipCorner === corner}
                aria-label={PIP_CORNER_LABELS[corner]}
                title={PIP_CORNER_LABELS[corner]}
                onClick={() => choosePipCorner(corner)}
                className={[
                  'relative z-50 grid h-9 w-9 place-items-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
                  pipCorner === corner ? 'bg-cyan-400/20' : 'hover:bg-white/[0.06]',
                ].join(' ')}
              >
                {/* A frame with a dot in the corner this button selects — the
                    picture of the choice, which is quicker to read at a glance
                    than ซ้ายบน/ขวาล่าง and needs no translation. The label is
                    still there for a screen reader. */}
                <span
                  aria-hidden
                  className={[
                    'grid h-5 w-4 rounded-[3px] border p-[2px]',
                    pipCorner === corner ? 'border-cyan-200/70' : 'border-white/35',
                    corner === 'top-left' || corner === 'top-right' ? 'items-start' : 'items-end',
                    corner === 'top-left' || corner === 'bottom-left'
                      ? 'justify-items-start'
                      : 'justify-items-end',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'h-1.5 w-1.5 rounded-[1px]',
                      pipCorner === corner ? 'bg-cyan-200' : 'bg-white/50',
                    ].join(' ')}
                  />
                </span>
              </button>
            ))}
          </div>
        )}

        <MenuButton
          ref={cameraButtonRef}
          open={openMenu === 'camera'}
          onToggle={() => setOpenMenu((current) => (current === 'camera' ? null : 'camera'))}
          icon={<Camera size={16} aria-hidden />}
          label="กล้อง"
          // The dot says "one of these is not on its default" without making
          // the creator open the menu to find out.
          badge={!isDefaultOrientation(orientation)}
        />

        <span className="ml-auto rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs tabular-nums text-white/50">
          {quality}
        </span>
      </div>
    </div>
  );
}

/**
 * A bottom-bar button that opens one of the row's panels.
 *
 * Positioned and lifted above the click-catcher so it stays tappable while a
 * panel is open — see the catcher's note. The panel itself belongs to the
 * row, not to this button.
 */
function MenuButton({
  ref,
  open,
  onToggle,
  icon,
  label,
  value,
  badge = false,
}: {
  ref: React.Ref<HTMLButtonElement>;
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
  /** The current setting, shown next to the label. Optional. */
  value?: string;
  badge?: boolean;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={onToggle}
      className={[
        'relative z-50 inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
        open
          ? 'border-white/20 bg-white/[0.10] text-white'
          : 'border-white/10 bg-white/[0.04] text-white/80 hover:bg-white/[0.08]',
      ].join(' ')}
    >
      {icon}
      {label}
      {value && <span className="text-white/40">{value}</span>}
      {badge && <OrientationChangedBadge />}
    </button>
  );
}

/**
 * A labelled on/off control in the bottom bar.
 *
 * Shaped like MenuButton rather than like the icon-only ControlButton beside
 * it, because it needs a word: mic and camera are universal glyphs and a
 * screen-share icon is not, and a creator hunting for this while live should
 * not have to hover anything to find it. `aria-pressed` rather than
 * `aria-expanded` — this toggles a thing, it does not open one.
 */
function ToggleButton({
  onClick,
  active,
  icon,
  label,
}: {
  onClick: () => void;
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'relative z-50 inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
        active
          ? 'border-cyan-400/40 bg-cyan-400/15 text-cyan-100 hover:bg-cyan-400/20'
          : 'border-white/10 bg-white/[0.04] text-white/80 hover:bg-white/[0.08]',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * What covers the video while the connection is not up.
 *
 * Three attempts happen by themselves; after that the creator gets a button,
 * because an automatic retry loop that never ends looks identical to a frozen
 * page.
 */
function ConnectionOverlay({
  phase,
  error,
  onRetry,
  fullBleed = false,
}: {
  phase: BroadcastPhase;
  error: string | null;
  onRetry: () => void;
  /**
   * Keep clear of the phone layout's right-hand rail.
   *
   * The framed studio has nothing beside this box, so it centres in it. In
   * full-bleed the rail is 44px of controls 12px from the right edge, and a
   * centred paragraph ran straight under them — the copy telling a creator
   * their connection dropped was the thing being covered.
   */
  fullBleed?: boolean;
}) {
  const padding = fullBleed ? 'pl-6 pr-[72px]' : 'px-6';

  if (phase === 'failed') {
    return (
      <div role="alert" className={`absolute inset-0 z-20 grid place-items-center bg-black/85 text-center ${padding}`}>
        <div>
          <WifiOff size={30} className="mx-auto text-rose-300" aria-hidden />
          <p className="mt-3 text-base font-semibold text-white">ไลฟ์หลุด — ลองใหม่</p>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-white/55">
            {error ?? 'การเชื่อมต่อขาดหาย'}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-cyan-400 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            เชื่อมต่อใหม่
          </button>
          <p className="mt-3 text-xs leading-relaxed text-white/40">
            ไลฟ์ยังไม่ถูกปิด — กด &ldquo;จบไลฟ์&rdquo; เพื่อปิดและดูสรุปผล
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`absolute inset-0 z-20 grid place-items-center bg-black/70 text-center ${padding}`}>
      <div>
        <Loader2 size={28} className="mx-auto animate-spin text-cyan-300" aria-hidden />
        <p className="mt-3 text-sm text-white/80" role="status">
          {phase === 'reconnecting' ? 'กำลังเชื่อมต่อใหม่...' : 'กำลังเชื่อมต่อ...'}
        </p>
      </div>
    </div>
  );
}

function ControlButton({
  onClick,
  active,
  label,
  icon,
}: {
  onClick: () => void | Promise<void>;
  active: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      aria-pressed={active}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
        active
          ? 'bg-white/10 text-white hover:bg-white/15'
          : 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
      }`}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </button>
  );
}
