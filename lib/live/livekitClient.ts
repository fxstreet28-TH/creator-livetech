'use client';

/**
 * The thin layer between this app and `livekit-client`.
 *
 * Everything the SDK is used for lives here — room construction, connecting as
 * publisher, device enumeration, and the Thai text for every way those can
 * fail — so the components stay React and the SDK stays in one file. That is
 * the same split as lib/creator/uploader.ts, which owns the XHR the upload
 * screen does not want to know about.
 *
 * SINCE THE LL-HLS MIGRATION THIS IS THE PUBLISHER'S SDK, NOT THE PLATFORM'S.
 *
 * The creator still publishes WebRTC into a LiveKit room because Bunny Live
 * has no WHIP ingest and a browser cannot speak RTMP. But a viewer is now an
 * HTTP request to a CDN, so three things that used to live here are gone:
 *
 *  - the chat and reaction data channel, which moved to a Supabase Realtime
 *    broadcast channel (./realtime.ts). Viewers are not in the room, so a data
 *    channel could not reach them.
 *  - viewerCountForViewer, replaced by presence on that same channel — a
 *    better number, because it goes down when someone leaves.
 *  - isCreatorIdentity, which asserted who the broadcaster was. That claim is
 *    now made by comparing against the creator id the backend returns; see the
 *    security note in ./realtime.ts.
 *
 * connectAsSubscriber survives only for a session with no Bunny stream — a row
 * from before the migration, or one whose Bunny create fell back.
 * TODO(phase 2B): remove it, and this dependency, once no such session can be
 * running.
 *
 * `@livekit/components-react` is deliberately NOT a dependency. Its prebuilt
 * conference UI is a different product from the bespoke layouts here, it ships
 * its own stylesheet that would fight the aurora theme, and it declares
 * `@livekit/krisp-noise-filter` as a peer.
 */

import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteTrack,
} from 'livekit-client';
import type { BroadcastQuality } from './types';
import { publishBitrateFor, qualityOption } from './constants';

export { ConnectionState, DisconnectReason, Room, RoomEvent, Track };
export type { RemoteTrack };

/**
 * Capture resolution for a quality choice.
 *
 * Built from the height rather than picked out of `VideoPresets` because that
 * set is 16:9 but has no 480p entry (only `VideoPresets43` does, at 4:3), and
 * a broadcast that silently switches aspect ratio between two adjacent quality
 * options is worse than one explicit calculation. Width is rounded to an even
 * number — some encoders reject odd dimensions.
 */
export function resolutionFor(quality: BroadcastQuality): {
  width: number;
  height: number;
  frameRate: number;
} {
  const { height } = qualityOption(quality);
  const width = Math.round((height * 16) / 9 / 2) * 2;
  // 30fps at every rung: the tier caps resolution, not smoothness, and 15fps
  // on the low tiers would read as a broken stream rather than a cheap one.
  return { width, height, frameRate: 30 };
}

/** Which camera a phone should open. Ignored by every device with only one. */
export type CameraFacing = 'user' | 'environment';

/**
 * A room configured for one-to-many broadcast.
 *
 * `adaptiveStream` lets a viewer's client drop to a lower simulcast layer when
 * its video element is small or hidden; `dynacast` stops the broadcaster
 * uploading layers nobody is watching. Both matter more here than in a
 * meeting: the platform pays LiveKit per participant-minute, and the budget
 * kill switch in `check_creator_can_golive` is what turns that bill into a
 * refusal to go live at all.
 */
export interface CreateRoomOptions {
  /**
   * Force every media path through a TURN server.
   *
   * The second rung of the viewer's recovery ladder. A direct or
   * server-reflexive candidate is cheaper and usually works, but on a
   * carrier-grade NAT, a corporate firewall, or one of the mobile networks
   * that quietly drops UDP, it never completes — and the viewer sees a
   * connection that hangs rather than one that fails, which is worse. Relay is
   * the route that works when nothing else does; it is not the default because
   * it costs bandwidth and adds a hop for the majority who do not need it.
   */
  iceTransportPolicy?: RTCIceTransportPolicy;
}

export function createRoom(quality?: BroadcastQuality, options?: CreateRoomOptions): Room {
  return new Room({
    adaptiveStream: true,
    dynacast: true,
    ...(quality ? { videoCaptureDefaults: { resolution: resolutionFor(quality) } } : {}),
    ...(options?.iceTransportPolicy
      ? { rtcConfig: { iceTransportPolicy: options.iceTransportPolicy } }
      : {}),
  });
}

export interface PublisherOptions {
  wsUrl: string;
  token: string;
  quality: BroadcastQuality;
  /**
   * The stream to publish.
   *
   * This is the canvas-composited stream from createFilteredStream, not the
   * camera — publishing it is what makes the creator's chosen look reach
   * viewers instead of stopping at their own preview. The tracks are published
   * explicitly rather than through `setCameraEnabled`, which would open the
   * camera a second time and publish the unfiltered frames.
   */
  stream: MediaStream;
  /** Start with the mic muted — the toggle on the setup screen. */
  micEnabled?: boolean;
  /**
   * Who is subscribing to this room.
   *
   * 'llhls' means the only subscriber is the egress worker; 'livekit' means
   * real viewers on real connections. It decides simulcast — see below.
   */
  delivery?: 'llhls' | 'livekit';
}

export interface PublishedTracks {
  video: LocalTrackPublication | undefined;
  audio: LocalTrackPublication | undefined;
}

/**
 * Connect and publish the supplied stream.
 *
 * Tracks go up in sequence rather than in parallel: LiveKit negotiates once
 * per publish, and two overlapping negotiations on a fresh connection is the
 * shape of bug that appears only on a slow network.
 *
 * The video track is marked `Source.Camera` even though it comes from a canvas
 * — that source is what LiveKit's `single-speaker` egress layout looks for
 * when deciding what to composite, and an unlabelled track composites as a
 * screen share.
 */
export async function connectAsPublisher(
  room: Room,
  options: PublisherOptions,
): Promise<PublishedTracks> {
  await room.connect(options.wsUrl, options.token);

  const [videoTrack] = options.stream.getVideoTracks();
  const [audioTrack] = options.stream.getAudioTracks();

  let video: LocalTrackPublication | undefined;
  let audio: LocalTrackPublication | undefined;

  if (videoTrack) {
    video = await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.Camera,
      videoEncoding: {
        maxFramerate: resolutionFor(options.quality).frameRate,
        maxBitrate: publishBitrateFor(options.quality),
      },
      /**
       * Hold the framerate, spend resolution, when the ceiling is not enough.
       *
       * The same trade the WHIP sender makes (see applyEncoderCeiling in
       * ./whipClient.ts) and for the same reason: a dropped framerate reads as
       * stutter, a briefly softer 720p picture does not.
       *
       * Stated rather than inherited. The SDK already defaults to exactly this
       * for `Source.Camera`, which is what this track is published as — so
       * today the line changes nothing. It is here because the default is
       * keyed on the SOURCE and this track is a canvas wearing a camera label
       * (see the note above on why), which makes the two coupled in a way
       * nothing enforces: publish it as anything else, or let the SDK revisit
       * its per-source defaults, and the encoder would quietly start trading
       * the other way. Cheaper to say what we want than to depend on someone
       * else's default continuing to agree with us.
       */
      degradationPreference: 'maintain-framerate',
      /**
       * H.264, not the SDK's default of VP8 — this is what makes the broadcast
       * visible on an iPhone.
       *
       * iOS Safari's WebRTC stack has a hardware decoder for H.264 and nothing
       * dependable behind VP8: the negotiation succeeds, the track subscribes,
       * the viewer count goes up, chat and gifts flow — and the video element
       * paints a black frame for the whole broadcast. It is the worst shape of
       * failure this platform has, because every signal a viewer or an operator
       * looks at says the stream is fine. Desktop Chrome has a solid software
       * VP8 decoder, which is why the default survived weeks of testing.
       *
       * Set for BOTH remaining subscriber kinds, not just LiveKit delivery:
       * under llhls the one subscriber is the egress worker, whose output is
       * HLS, and HLS carries H.264/H.265 only — so publishing VP8 there buys a
       * transcode on the way out and nothing else.
       *
       * Simulcast below is unaffected: LiveKit encodes H.264 layers the same
       * way it encodes VP8 ones.
       */
      videoCodec: 'h264',
      /**
       * On only when real viewers subscribe to this room.
       *
       * Simulcast exists so an SFU can hand each viewer the layer their
       * connection can take. Under LL-HLS the room has exactly one subscriber
       * — the egress — and it always wants the top layer, so the two spare
       * encodes would be CPU spent on a machine that is already running the
       * filter canvas. Under LiveKit delivery every viewer is a subscriber, a
       * phone on Thai mobile data cannot hold 3 Mbps, and without simulcast it
       * gets a stuttering 720p instead of a clean 360p.
       */
      simulcast: options.delivery !== 'llhls',
    });
  }

  if (audioTrack) {
    audio = await room.localParticipant.publishTrack(audioTrack, {
      source: Track.Source.Microphone,
    });
    if (options.micEnabled === false) await audio.mute();
  }

  return { video, audio };
}

/** Connect as a viewer. The token carries canPublish: false, so nothing is captured. */
export async function connectAsSubscriber(
  room: Room,
  wsUrl: string,
  token: string,
): Promise<void> {
  await room.connect(wsUrl, token);
}

/**
 * The room's other participants.
 *
 * NOT the audience any more. On a broadcast this is the egress worker — the
 * one participant LiveKit adds to composite the room for Bunny — so it is a
 * useful signal that delivery is actually attached, and useless as a viewer
 * count. The audience comes from Realtime presence; see ./realtime.ts.
 */
export function remoteParticipantCount(room: Room | null): number {
  return room?.remoteParticipants.size ?? 0;
}

/** Cameras the browser will admit to, for the picker. Empty before permission is granted. */
export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  try {
    return await Room.getLocalDevices('videoinput', false);
  } catch (err) {
    console.error('[live/livekit] enumerate video inputs failed', err);
    return [];
  }
}

/** Stop every local track and leave the room. Safe to call twice. */
export async function leaveRoom(room: Room | null): Promise<void> {
  if (!room) return;
  try {
    await room.disconnect();
  } catch (err) {
    console.error('[live/livekit] disconnect failed', err);
  }
}

/** The publication of a local track kind, for level metering and mute state. */
export function localPublication(
  room: Room | null,
  source: Track.Source,
): LocalTrackPublication | undefined {
  return room?.localParticipant.getTrackPublication(source);
}

const MEDIA_ERROR_NAMES = new Set([
  'NotAllowedError',
  'SecurityError',
  'NotFoundError',
  'DevicesNotFoundError',
  'NotReadableError',
  'TrackStartError',
  'OverconstrainedError',
]);

/**
 * Thai for a getUserMedia failure.
 *
 * The DOMException names are the contract here, not the messages, which differ
 * per browser and are in English. `NotAllowedError` is by far the common one
 * and is the only one a creator can act on, so it gets the instruction.
 */
export function thaiForMediaError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'เบราว์เซอร์ปฏิเสธการเข้าถึงกล้องหรือไมโครโฟน กรุณาอนุญาตในการตั้งค่าเบราว์เซอร์แล้วลองใหม่';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'ไม่พบกล้องหรือไมโครโฟนบนอุปกรณ์นี้';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'กล้องถูกใช้งานโดยแอปอื่นอยู่ กรุณาปิดแอปนั้นแล้วลองใหม่';
    case 'OverconstrainedError':
      return 'กล้องนี้ไม่รองรับความละเอียดที่เลือก กรุณาเลือกคุณภาพต่ำลง';
    default:
      return 'เปิดกล้องไม่สำเร็จ กรุณาลองใหม่';
  }
}

/**
 * Thai for a failure to connect or publish to LiveKit.
 *
 * A media failure is passed through to thaiForMediaError: connectAsPublisher
 * does both jobs, and "อนุญาตกล้อง" is a very different instruction from
 * "ตรวจสอบอินเทอร์เน็ต".
 */
export function thaiForConnectError(err: unknown): string {
  if (err instanceof Error && MEDIA_ERROR_NAMES.has(err.name)) {
    return thaiForMediaError(err);
  }
  const text = err instanceof Error ? err.message.toLowerCase() : '';
  if (text.includes('token') || text.includes('permission') || text.includes('unauthorized')) {
    return 'สิทธิ์เข้าห้องไลฟ์หมดอายุ กรุณาเริ่มไลฟ์ใหม่อีกครั้ง';
  }
  return 'เชื่อมต่อเซิร์ฟเวอร์ไลฟ์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
}
