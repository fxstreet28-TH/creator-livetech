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

import { useCallback, useState } from 'react';
import {
  Camera,
  Gift,
  Mic,
  MicOff,
  RefreshCw,
  Sparkles,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { formatCount, formatDuration } from '@/lib/creator/format';
import type { LiveChatEntry } from '@/lib/live/types';
import type { LiveChannelStatus } from '@/lib/live/realtime';
import type { FloatingReaction } from '@/lib/live/reactions';
import type { LiveGiftEvent } from '@/lib/live/gifts';
import type { CameraOrientation } from '@/lib/live/cameraOrientation';
import type { FilterId } from '@/lib/live/cameraFilters';
import { CreatorBroadcaster, type BroadcastControls } from '../CreatorBroadcaster';
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
  quality: string;
  delivery: 'llhls' | 'livekit';
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
}

/** Which bottom sheet is open, if any. */
type Sheet = 'look' | 'camera' | null;

export function CreatorLiveMobile(props: CreatorLiveMobileProps) {
  const {
    liveSessionId,
    wsUrl,
    token,
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
        portrait
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

      <RailButton
        onClick={controls.flipCamera}
        disabled={controls.flippingCamera}
        label={controls.facing === 'user' ? 'สลับไปกล้องหลัง' : 'สลับไปกล้องหน้า'}
        icon={
          <RefreshCw
            size={18}
            className={controls.flippingCamera ? 'animate-spin' : ''}
            aria-hidden
          />
        }
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
