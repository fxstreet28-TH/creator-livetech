'use client';

/**
 * The bench. Fabricates the page state CreatorLiveMobile takes and renders the
 * real component against it — see the server component beside this file.
 *
 * The camera IS real: run this in a browser with a webcam, or in headless
 * Chromium with `--use-fake-device-for-media-stream`, and the self-view is the
 * genuine filter-canvas pipeline the broadcast publishes. That is what makes
 * it useful for checking the portrait capture.
 */

import { useCallback, useMemo, useState } from 'react';
import { CreatorLiveMobile } from '@/components/live/mobile/CreatorLiveMobile';
import { DEFAULT_CAMERA_ORIENTATION, type CameraOrientation } from '@/lib/live/cameraOrientation';
import { DEFAULT_FILTER_ID, type FilterId } from '@/lib/live/cameraFilters';
import type { LiveChatEntry } from '@/lib/live/types';
import type { LiveGiftEvent } from '@/lib/live/gifts';

const SESSION_ID = 'dev-creator-bench';

const CHAT: LiveChatEntry[] = [
  { id: 'c1', text: 'สวัสดีครับอาจารย์', sender: 'somchai_2540', timestamp: 0, senderId: 'u1', isCreator: false, isSelf: false },
  { id: 'c2', text: 'เสียงชัดมากครับ', sender: 'nok_investor', timestamp: 0, senderId: 'u2', isCreator: false, isSelf: false },
  { id: 'c3', text: 'ขอบคุณครับทุกคน', sender: 'อ.ปอ AURUM', timestamp: 0, senderId: 'me', isCreator: true, isSelf: true },
  { id: 'c4', text: 'somchai_2540 ส่ง Stardust ×3', sender: 'ระบบ', timestamp: 0, senderId: null, isCreator: false, isSelf: false, giftRarity: 'basic' },
  { id: 'c5', text: 'รอฟังต่อครับ 🔥', sender: 'pim_trader', timestamp: 0, senderId: 'u3', isCreator: false, isSelf: false },
];

function giftEvent(kind: 'tray' | 'fullscreen'): LiveGiftEvent {
  const tray = kind === 'tray';
  return {
    gift_id: `dev-${kind}-${Date.now()}`,
    session_id: SESSION_ID,
    tier_id: tray ? 1 : 4,
    tier_slug: tray ? 'stardust' : 'nova',
    name_en: tray ? 'Stardust' : 'Nova',
    name_th: tray ? 'ผงดาว' : 'โนวา',
    rarity: tray ? 'basic' : 'legendary',
    animation_key: tray ? 'stardust' : 'nova',
    display_mode: tray ? 'tray' : 'fullscreen',
    duration_ms: tray ? 4500 : 10000,
    sort_order: tray ? 1 : 4,
    quantity: tray ? 3 : 1,
    stars_total: tray ? 3 : 100,
    message: tray ? null : 'สู้ ๆ นะครับอาจารย์',
    sender: { id: 'u1', display_name: 'somchai_2540', avatar_url: null },
    created_at: new Date().toISOString(),
  };
}

export function CreatorLiveMobileBench() {
  const [filterId, setFilterId] = useState<FilterId>(DEFAULT_FILTER_ID);
  const [orientation, setOrientation] = useState<CameraOrientation>(DEFAULT_CAMERA_ORIENTATION);
  const [latestGift, setLatestGift] = useState<LiveGiftEvent | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [ended, setEnded] = useState(false);
  /** Emulate an iPhone's safe areas — env() cannot be set from a stylesheet. */
  const [notch, setNotch] = useState(true);
  /**
   * Phone path or desktop path.
   *
   * On (the default) the camera is opened the way a phone opens it — asking for
   * nothing but facing and frame rate, so the source arrives at the camera's
   * OWN ratio. Run this bench with a 4:3 synthetic source (see the README
   * beside the test cards) and the whole pipeline is exercised at the ratio a
   * real iPhone actually gives.
   *
   * Off takes the desktop constraints instead, which is how the landscape
   * source and its letterboxed self-view get checked from here.
   */
  const [portrait, setPortrait] = useState(true);

  const noopSend = useCallback(async () => undefined, []);
  const giftTotals = useMemo(() => ({ count: 12, stars: 340 }), []);

  return (
    <>
      {notch && (
        <style>{`[data-creator-live-mobile-root]{--live-safe-top:59px!important;--live-safe-bottom:34px!important}`}</style>
      )}

      <CreatorLiveMobile
        key={portrait ? 'phone' : 'desktop'}
        liveSessionId={SESSION_ID}
        // Deliberately unreachable: there is no room, and the connection
        // overlay it produces is part of what this bench is for.
        wsUrl="wss://example.invalid"
        token="dev-token"
        quality="720p"
        delivery="llhls"
        whipUrl=""
        micEnabled
        elapsedSeconds={761}
        debugCamera
        portrait={portrait}
        filterId={filterId}
        onFilterIdChange={setFilterId}
        orientation={orientation}
        onOrientationChange={setOrientation}
        viewerCount={1204}
        reactions={[]}
        latestGift={latestGift}
        giftTotals={giftTotals}
        soundEnabled={soundEnabled}
        onSoundToggle={() => setSoundEnabled((on) => !on)}
        chat={CHAT}
        chatStatus="connected"
        onSendChat={noopSend}
        onEndRequest={() => setEnded(true)}
        endDialog={
          ended ? (
            <div className="absolute inset-0 z-40 grid place-items-center bg-black/80 p-6 text-center">
              <div className="rounded-2xl border border-white/15 bg-[#0c101b] p-6">
                <p className="text-base font-bold text-white">ยืนยันจบไลฟ์?</p>
                <button
                  type="button"
                  onClick={() => setEnded(false)}
                  className="mt-4 rounded-xl border border-white/15 px-4 py-2 text-sm text-white"
                >
                  ยกเลิก
                </button>
              </div>
            </div>
          ) : null
        }
      />

      <div
        data-bench-controls
        className="fixed left-1/2 top-1/2 z-[100] flex w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-wrap justify-center gap-1.5 rounded-xl bg-black/70 p-2 backdrop-blur-md"
      >
        <BenchButton onClick={() => setLatestGift(giftEvent('tray'))}>tray gift</BenchButton>
        <BenchButton onClick={() => setLatestGift(giftEvent('fullscreen'))}>fullscreen gift</BenchButton>
        <BenchButton onClick={() => setNotch((on) => !on)}>
          {notch ? 'safe areas: iPhone' : 'safe areas: none'}
        </BenchButton>
        {/* Re-keys the layout so the camera is re-OPENED with the other
            constraint set. A live applyConstraints would not do: on iOS that
            is itself a way to get cropped, which is what this is all about. */}
        <BenchButton onClick={() => setPortrait((on) => !on)}>
          {portrait ? 'camera: phone (unconstrained)' : 'camera: desktop (16:9)'}
        </BenchButton>
      </div>
    </>
  );
}

function BenchButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-white/15 bg-white/10 px-2 py-1 text-[11px] font-semibold text-white"
    >
      {children}
    </button>
  );
}
