'use client';

/**
 * /creator/live on a phone — the host side of "Design C".
 *
 * WHY THIS EXISTS. There was no phone layout at all: /creator/live rendered the
 * desktop studio at whatever width it was given. On an iPhone in portrait that
 * meant a small 16:9 preview box with the control row wrapped underneath it,
 * and the row is where "จบไลฟ์" lives — so it wrapped off the bottom of the
 * screen and the creator could not end their own broadcast. The session had to
 * be closed by the watchdog. A control that stops a running, billing broadcast
 * is not allowed to be reachable only by scrolling, so here it is the ONE thing
 * pinned above everything else.
 *
 * A SIBLING OF THE DESKTOP STUDIO, not a replacement: below 768px this renders
 * and BroadcastingLayout does not, and from 768px the reverse. They share the
 * engine — CreatorBroadcaster owns the camera, the filter canvas, the LiveKit
 * room and the egress either way, and hands its controls out through
 * `controls` (see BroadcastControls).
 *
 * IT MIRRORS THE VIEWER. Same full-bleed video, same overlaid chat in its
 * `overlay` variant, same right-hand rail, same composer, and — through
 * useMobileGiftAnchor — literally the same gift geometry, so a creator watching
 * their own screen sees a gift where their audience sees it. GiftOverlay's
 * header states that rule; this is what keeps it true on a phone.
 *
 * WHAT IS DIFFERENT FROM THE VIEWER, and why:
 *
 *  - The rail is the HOST's controls (mic, flip camera, look, camera, gift
 *    sound), not reactions. A creator does not react to themselves.
 *  - There is no ✕. Leaving is ending, and ending goes through the confirm.
 *  - The chat is read-only-ish in shape but the creator can still send: they
 *    are in their own room and answering a question is the point.
 */

import { useCallback, useRef, useState } from 'react';
import {
  Camera,
  Gift,
  Mic,
  MicOff,
  RefreshCw,
  Sparkles,
  SquareSplitVertical,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { formatCount, formatDuration } from '@/lib/creator/format';
import type { LiveChatEntry, LiveDelivery } from '@/lib/live/types';
import type { LiveChannelStatus } from '@/lib/live/realtime';
import type { FloatingReaction } from '@/lib/live/reactions';
import type { LiveGiftEvent } from '@/lib/live/gifts';
import type { CameraOrientation } from '@/lib/live/cameraOrientation';
import { filterLabelFor, type FilterId } from '@/lib/live/cameraFilters';
import {
  CreatorBroadcaster,
  ULTRA_WIDE_STEP,
  ZOOM_STEPS,
  type BroadcastControls,
} from '../CreatorBroadcaster';
import { CameraControlsMenu } from '../CameraControlsMenu';
import { CameraFilterSelector } from '../CameraFilterSelector';
import { LiveBadge } from '../LiveStatsBar';
import { LiveChat } from '../LiveChat';
import { GiftOverlay } from '../gifts/GiftOverlay';
import { useKeyboardInset } from './useMobileViewport';
import { useMobileGiftGeometry } from './useMobileGiftAnchor';
import styles from './CreatorLiveMobile.module.css';

export interface CreatorLiveMobileProps {
  liveSessionId: string;
  wsUrl: string;
  token: string;
  /** SECURITY: the WHIP publish capability on an origin session. See CreatorBroadcaster. */
  whipUrl: string;
  quality: string;
  delivery: LiveDelivery;
  micEnabled: boolean;
  elapsedSeconds: number;
  filterId: FilterId;
  onFilterIdChange: (next: FilterId) => void;
  orientation: CameraOrientation;
  onOrientationChange: (next: CameraOrientation) => void;
  viewerCount: number;
  reactions: FloatingReaction[];
  latestGift: LiveGiftEvent | null;
  giftTotals: { count: number; stars: number };
  soundEnabled: boolean;
  onSoundToggle: () => void;
  chat: LiveChatEntry[];
  chatStatus: LiveChannelStatus;
  onSendChat: (text: string) => Promise<void>;
  /** Opens the existing confirm. Ending never happens on one tap. */
  onEndRequest: () => void;
  /** The confirm / summary dialog, owned by the page. */
  endDialog?: React.ReactNode;
  /**
   * Show the camera's real numbers on screen.
   *
   * `?debug=camera` on /creator/live, and always in the dev bench. It exists
   * because "the picture looks zoomed" cannot be acted on and
   * "720x1280 ar0.563 portrait (cam max 1920)" can — the last part being the
   * tell that the browser handed back a crop of a wider sensor mode.
   */
  debugCamera?: boolean;
  /**
   * Ask the camera for an upright frame. True for a phone held upright, which
   * is every case this layout ships for today.
   *
   * It is a prop rather than a constant for two reasons: /dev/creator-live
   * needs to drive a LANDSCAPE source to exercise the `portraitRefused`
   * branch, and the queued landscape-orientation work will set it from the
   * device's own orientation rather than from a hardcoded true.
   */
  portrait?: boolean;
}

/** Which bottom sheet is open, if any. */
type Sheet = 'look' | 'camera' | null;

export function CreatorLiveMobile(props: CreatorLiveMobileProps) {
  const {
    liveSessionId,
    wsUrl,
    token,
    whipUrl,
    quality,
    delivery,
    micEnabled,
    elapsedSeconds,
    filterId,
    onFilterIdChange,
    orientation,
    onOrientationChange,
    viewerCount,
    reactions,
    latestGift,
    giftTotals,
    soundEnabled,
    onSoundToggle,
    chat,
    chatStatus,
    onSendChat,
    onEndRequest,
    endDialog,
    debugCamera = false,
    portrait = true,
  } = props;

  const keyboardInset = useKeyboardInset();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [chatExpanded, setChatExpanded] = useState(false);

  /**
   * The gift geometry, from the one module the viewer screen uses too.
   * Destructured rather than kept as an object because the lint rule that
   * guards ref access reads `x.setSomething` in JSX as a ref write.
   */
  const {
    anchor: giftAnchor,
    setBottomStackNode,
    onTrayTopChange: handleTrayTop,
  } = useMobileGiftGeometry();

  const closeSheet = useCallback(() => setSheet(null), []);

  /**
   * Pinch-to-zoom.
   *
   * The gesture is read on the ROOT rather than on the video, because the
   * video sits in a fixed layer underneath every control and a listener there
   * would miss a pinch that started over the chat. Two fingers only: one is a
   * tap on a button, and `touches.length` is the whole discriminator.
   *
   * The starting distance and the starting zoom are captured on touchstart, so
   * the gesture is a RATIO applied to where the creator already was — pinching
   * from 2x behaves like pinching from 2x, not like starting again at 1x.
   */
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const zoomHandlersFor = (c: BroadcastControls) => ({
    onTouchStart: (event: React.TouchEvent) => {
      if (event.touches.length !== 2) return;
      pinchRef.current = { distance: touchDistance(event.touches), zoom: c.zoom };
    },
    onTouchMove: (event: React.TouchEvent) => {
      const start = pinchRef.current;
      if (!start || event.touches.length !== 2 || start.distance <= 0) return;
      const ratio = touchDistance(event.touches) / start.distance;
      c.setZoom(round1(start.zoom * ratio));
    },
    onTouchEnd: () => {
      pinchRef.current = null;
    },
  });

  return (
    <div
      data-creator-live-mobile-root
      className={styles.root}
      style={{ '--live-keyboard': `${keyboardInset}px` } as React.CSSProperties}
    >
      <CreatorBroadcaster
        liveSessionId={liveSessionId}
        wsUrl={wsUrl}
        token={token}
        whipUrl={whipUrl}
        quality={quality as never}
        delivery={delivery}
        micEnabled={micEnabled}
        elapsedSeconds={elapsedSeconds}
        filterId={filterId}
        onFilterIdChange={onFilterIdChange}
        orientation={orientation}
        onOrientationChange={onOrientationChange}
        viewerCount={viewerCount}
        reactions={reactions}
        presentation="fullbleed"
        // The whole point of the phone path: ask the camera for a portrait
        // frame so the broadcast is portrait-shaped end to end.
        portrait={portrait}
        // Only while the chip is on screen — the fps readout re-renders this
        // whole layout every second, which is a fine price for a diagnostic
        // and an absurd one for a broadcast nobody is debugging.
        reportStats={debugCamera}
        overlay={
          <GiftOverlay
            latestGift={latestGift}
            resetKey={liveSessionId}
            inset={12}
            anchor={giftAnchor}
            onTrayTopChange={handleTrayTop}
          />
        }
        controls={(c) => (
          <>
            <div className={styles.scrimTop} aria-hidden />
            <div className={styles.scrimBottom} aria-hidden />

            <TopBar
              controls={c}
              elapsedSeconds={elapsedSeconds}
              viewerCount={viewerCount}
              onEndRequest={onEndRequest}
            />

            <Rail
              controls={c}
              sheet={sheet}
              onSheet={setSheet}
              soundEnabled={soundEnabled}
              onSoundToggle={onSoundToggle}
              orientationIsCustom={orientation}
            />

            {/* The pinch surface. Transparent, inert to clicks, and BELOW
                every control (z-1 against their z-20) so it can never swallow
                a tap — it only ever sees the second finger. */}
            <div className={styles.pinchLayer} aria-hidden {...zoomHandlersFor(c)} />

            {debugCamera && (
              <div className={styles.debugChip} role="status">
                <span>{c.cameraReport}</span>
                <span>
                  zoom {c.zoom.toFixed(1)}× {c.hardwareZoom ? 'hw' : 'digital'} · max{' '}
                  {c.maxZoom.toFixed(1)}×
                </span>
                {/* The look implementation and what it costs. `composite` is
                    the path older WebKit takes, where ctx.filter does nothing;
                    the fps beside it is the evidence that the blend passes are
                    as cheap as they are claimed to be. */}
                <span>
                  look {filterLabelFor(filterId)} · {c.lookMode ?? '—'} · {c.captureFps || '—'}fps
                </span>
                {/*
                  WHICH TIER THIS PHONE LANDED ON. The one line that answers
                  the only question the dual-camera feature has: "—" until the
                  creator taps, then the device's own verdict. Reading it off
                  the screen beats reading it out of Safari's remote inspector
                  over a USB cable, which is the alternative.
                */}
                {c.dualCameraAvailable && (
                  <span>
                    dualcam {c.dualCameraTier ?? 'unprobed'} ·{' '}
                    {c.dualCameraOn ? 'on (back→top, front→bottom)' : 'off'}
                  </span>
                )}
                {c.portraitRefused && (
                  <span className={styles.debugWarn}>
                    camera refused portrait — publishing 16:9, NOT cropping
                  </span>
                )}
              </div>
            )}

            {/*
              WHAT THE PHONE SAID WHEN IT WAS ASKED FOR TWO CAMERAS.

              Rendered only after a tap that did not work, and dismissible
              rather than timed: it tells the creator to reach for a DIFFERENT
              control, and a message that fades before it is read leaves them
              with a button that appeared to do nothing.
            */}
            {c.dualCameraNotice && (
              <div className={styles.dualNotice} role="status">
                <span>{c.dualCameraNotice}</span>
                <button
                  type="button"
                  onClick={c.clearDualCameraNotice}
                  className={styles.dualNoticeDismiss}
                >
                  ปิด
                </button>
              </div>
            )}

            {sheet === 'camera' && (
              <ZoomSlider
                zoom={c.zoom}
                minZoom={c.minZoom}
                maxZoom={c.maxZoom}
                hardware={c.hardwareZoom}
                onChange={c.setZoom}
              />
            )}
          </>
        )}
      />

      {/* Mounted only while expanded, so it cannot eat taps meant for the
          controls underneath — same rule as the viewer's catcher. */}
      {chatExpanded && (
        <button
          type="button"
          aria-label="ย่อแชท"
          onClick={() => setChatExpanded(false)}
          className={styles.collapseCatcher}
        />
      )}

      {/* --------------------------------------------------- bottom stack */}
      <div ref={setBottomStackNode} className={styles.bottomStack}>
        <div className={styles.giftChip}>
          <span className="inline-flex items-center gap-1">
            <Gift size={13} aria-hidden />
            <span className="tabular-nums">{formatCount(giftTotals.count)}</span>
          </span>
          <span className="text-amber-200">
            ⭐ <span className="tabular-nums">{formatCount(giftTotals.stars)}</span>
          </span>
        </div>

        <LiveChat
          entries={chat}
          onSend={onSendChat}
          status={chatStatus}
          variant="overlay"
          expanded={chatExpanded}
          onExpandedChange={setChatExpanded}
          className={styles.composer}
          listClassName={styles.chat}
        />
      </div>

      {/* ------------------------------------------------------- sheets */}
      {sheet && (
        <>
          <button
            type="button"
            aria-label="ปิด"
            onClick={closeSheet}
            className={styles.sheetScrim}
          />
          <div className={styles.sheet} role="dialog" aria-modal="true">
            <div className={styles.sheetGrip} aria-hidden />
            {sheet === 'look' ? (
              <CameraFilterSelector value={filterId} onChange={onFilterIdChange} />
            ) : (
              <CameraControlsMenu value={orientation} onChange={onOrientationChange} />
            )}
          </div>
        </>
      )}

      {endDialog}
    </div>
  );
}

/**
 * The top bar, and the one control that may never be hidden.
 *
 * "จบไลฟ์" is a red pill at z-30 — above the sheets, above the chat, above the
 * gift overlay, above everything the page can draw. That is the fix for the
 * reported bug: a creator with a running broadcast must always be one tap from
 * stopping it, and the tap opens the same confirm the desktop studio uses
 * rather than ending on the spot.
 */
function TopBar({
  controls,
  elapsedSeconds,
  viewerCount,
  onEndRequest,
}: {
  controls: BroadcastControls;
  elapsedSeconds: number;
  viewerCount: number;
  onEndRequest: () => void;
}) {
  return (
    <div className={styles.topBar}>
      <div className={styles.topStats}>
        {controls.phase === 'live' ? (
          <LiveBadge pulse />
        ) : (
          <span className={styles.connectingPill}>
            {controls.phase === 'reconnecting' ? 'กำลังเชื่อมต่อใหม่' : 'กำลังเชื่อมต่อ'}
          </span>
        )}
        <span className="tabular-nums">{formatDuration(elapsedSeconds)}</span>
        <span className="tabular-nums">👁 {formatCount(viewerCount)}</span>
      </div>

      <button type="button" onClick={onEndRequest} className={styles.endButton}>
        จบไลฟ์
      </button>

      {/* The room is up but the CDN is not receiving it yet. Said out loud:
          a creator whose viewer count never moves deserves to know why. */}
      {controls.phase === 'live' && !controls.deliveryLive && (
        <span className={styles.deliveryPill}>กำลังเริ่มส่งสัญญาณ…</span>
      )}
      {controls.deliveryError && controls.phase === 'live' && (
        <span className={`${styles.deliveryPill} ${styles.deliveryPillBad}`} role="alert">
          {controls.deliveryError} — ผู้ชมยังดูไม่ได้
        </span>
      )}
    </div>
  );
}

/** The host's controls, down the right edge where a thumb reaches them. */
function Rail({
  controls,
  sheet,
  onSheet,
  soundEnabled,
  onSoundToggle,
  orientationIsCustom,
}: {
  controls: BroadcastControls;
  sheet: Sheet;
  onSheet: (next: Sheet) => void;
  soundEnabled: boolean;
  onSoundToggle: () => void;
  orientationIsCustom: CameraOrientation;
}) {
  return (
    <div className={styles.rail}>
      <RailButton
        onClick={controls.toggleMic}
        label={controls.micOn ? 'ปิดไมโครโฟน' : 'เปิดไมโครโฟน'}
        danger={!controls.micOn}
        icon={controls.micOn ? <Mic size={19} aria-hidden /> : <MicOff size={19} aria-hidden />}
      >
        {/* The level meter rides on the mic button rather than taking a slot
            of its own — the rail has to finish above the gift stage. */}
        {controls.micOn && (
          <span
            className={styles.level}
            style={{ transform: `scaleX(${Math.min(1, controls.audioLevel * 3)})` }}
            aria-hidden
          />
        )}
      </RailButton>

      <RailButton
        onClick={controls.toggleCamera}
        label={controls.camOn ? 'ปิดกล้อง' : 'เปิดกล้อง'}
        danger={!controls.camOn}
        icon={controls.camOn ? <Video size={19} aria-hidden /> : <VideoOff size={19} aria-hidden />}
      />

      {/*
        Disabled while both cameras are on screen: there is nothing to flip TO,
        because the camera this would swap to is the one already filling the
        top half of the frame. The guard is in flipCamera as well — see there.
      */}
      <RailButton
        onClick={controls.flipCamera}
        disabled={controls.flippingCamera || controls.dualCameraOn}
        label={
          controls.dualCameraOn
            ? 'สลับกล้องไม่ได้ขณะเปิดกล้องคู่'
            : controls.facing === 'user'
              ? 'สลับไปกล้องหลัง'
              : 'สลับไปกล้องหน้า'
        }
        icon={
          <RefreshCw
            size={18}
            className={controls.flippingCamera ? 'animate-spin' : ''}
            aria-hidden
          />
        }
      />

      {/*
        กล้องคู่ — the phone's answer to the desktop's แชร์หน้าจอ.

        ABSENT rather than disabled where the device has only one camera, which
        is the same rule the screen-share button follows on a desktop without
        getDisplayMedia: a greyed-out control is a promise that it might work
        later, and on a one-camera device it never will.

        Whether a two-camera device will actually run BOTH at once is not
        knowable until it is asked, so this button renders on any phone with
        two cameras and the answer arrives on the first tap — up to a second
        and a half later, which is what the disabled state during
        `dualCameraBusy` is for.
      */}
      {controls.dualCameraAvailable && (
        <RailButton
          onClick={controls.toggleDualCamera}
          disabled={controls.dualCameraBusy}
          active={controls.dualCameraOn}
          label={
            controls.dualCameraOn
              ? 'ปิดกล้องคู่'
              : controls.dualCameraBusy
                ? 'กำลังตรวจสอบกล้องคู่'
                : 'เปิดกล้องคู่ (หลังบน + หน้าล่าง)'
          }
          icon={
            <SquareSplitVertical
              size={18}
              className={controls.dualCameraBusy ? 'animate-pulse' : ''}
              aria-hidden
            />
          }
        />
      )}

      {/* 1× → 2× → 3× → 1×. The label IS the state: a zoom a creator cannot
          read off the screen is one they forget they left on. */}
      <RailButton
        onClick={() =>
          controls.setZoom(nextZoomStep(controls.zoom, controls.minZoom, controls.maxZoom))
        }
        label={`ซูม ${controls.zoom.toFixed(1)} เท่า`}
        active={controls.zoom > 1}
        icon={<span className={styles.zoomLabel}>{formatZoom(controls.zoom)}</span>}
      />

      <RailButton
        onClick={() => onSheet(sheet === 'look' ? null : 'look')}
        active={sheet === 'look'}
        label="เลือกลุค"
        icon={<Sparkles size={18} aria-hidden />}
      />

      <RailButton
        onClick={() => onSheet(sheet === 'camera' ? null : 'camera')}
        active={sheet === 'camera'}
        label="ตั้งค่ากล้อง"
        icon={<Camera size={18} aria-hidden />}
        // The dot says "one of these is not on its default" without making the
        // creator open the sheet to find out.
        badge={
          orientationIsCustom.mirrorPreview !== true || orientationIsCustom.flipOutput !== false
        }
      />

      <RailButton
        onClick={onSoundToggle}
        label={soundEnabled ? 'ปิดเสียงของขวัญ' : 'เปิดเสียงของขวัญ'}
        icon={
          soundEnabled ? <Volume2 size={18} aria-hidden /> : <VolumeX size={18} aria-hidden />
        }
      />
    </div>
  );
}

/**
 * The next rung, wrapping round.
 *
 * Rungs rather than a continuous step because a rail button is a thumb tap,
 * not a dial — the slider and the pinch are there for anything in between. A
 * rung past what this camera can do is skipped rather than clamped, so a
 * device whose ceiling is 2x cycles 1 → 2 → 1 instead of appearing to stick.
 *
 * 0.5x joins the front of the cycle only where the camera's own zoom range
 * reaches below 1 — a rear ultra-wide. It is hidden entirely otherwise, rather
 * than shown and clamped to 1: a button that promises a wider shot and gives
 * the same one is worse than no button.
 */
function nextZoomStep(current: number, minZoom: number, maxZoom: number): number {
  const usable = [
    ...(minZoom < 1 ? [ULTRA_WIDE_STEP] : []),
    ...ZOOM_STEPS.filter((step) => step <= maxZoom + 0.001),
  ];
  if (usable.length === 0) return 1;
  const index = usable.findIndex((step) => step > current + 0.001);
  return index === -1 ? usable[0] : usable[index];
}

/** "1×" / "2.5×" — trailing ".0" dropped, because 1× reads better than 1.0×. */
function formatZoom(zoom: number): string {
  const rounded = Math.round(zoom * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}×`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function touchDistance(touches: React.TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * The fine control, in the กล้อง sheet next to the mirror switches.
 *
 * A native range input: it is the one control here that wants a drag, and a
 * hand-rolled one would lose the platform's own touch target and its
 * accessibility for nothing.
 */
function ZoomSlider({
  zoom,
  minZoom,
  maxZoom,
  hardware,
  onChange,
}: {
  zoom: number;
  minZoom: number;
  maxZoom: number;
  hardware: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div className={styles.zoomSlider}>
      <div className={styles.zoomSliderHead}>
        <span>ซูม</span>
        <span className="tabular-nums">{formatZoom(zoom)}</span>
      </div>
      <input
        type="range"
        min={minZoom}
        max={Math.max(minZoom + 0.1, maxZoom)}
        step={0.1}
        value={zoom}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="ระดับการซูม"
        className={styles.zoomRange}
      />
      <p className={styles.zoomNote}>
        {hardware
          ? 'ใช้การซูมของกล้องโดยตรง — ความคมชัดไม่ลดลง'
          : 'ซูมแบบดิจิทัล — ยิ่งซูมมาก ภาพยิ่งไม่คมเท่าเดิม'}
      </p>
    </div>
  );
}

function RailButton({
  onClick,
  label,
  icon,
  active = false,
  danger = false,
  disabled = false,
  badge = false,
  children,
}: {
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  badge?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      className={[
        styles.railButton,
        active ? styles.railButtonActive : '',
        danger ? styles.railButtonDanger : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon}
      {badge && <span className={styles.railBadge} aria-hidden />}
      {children}
    </button>
  );
}
