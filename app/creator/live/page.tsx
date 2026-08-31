'use client';

/**
 * /creator/live — set up a broadcast, then run it.
 *
 * One route with two states rather than two routes. The go-live call returns a
 * LiveKit token that only exists in memory (it is a room credential — never
 * stored, never in a URL), so a navigation between setup and broadcasting
 * would throw away the only copy and force a second session to be created.
 *
 * Broadcasting from a phone is best-effort: getUserMedia inside a Capacitor
 * WebView is unreliable and desktop web is the supported path this sprint
 * (non-negotiable #7). The layout still works on a small screen — the chat
 * moves under the video instead of beside it — but nothing here tries to fix
 * a WebView that will not open a camera.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useCreatorProfile } from '@/lib/hooks/useCreatorProfile';
import { usePlatformStatus } from '@/lib/hooks/usePlatformStatus';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { CREATOR_PPV_ENABLED } from '@/lib/features';
import { describePlatformBlock, isDegraded } from '@/lib/platform/status';
import { createLiveSession, describeGoliveBlock, endLiveSession, fetchLiveQuota } from '@/lib/live/api';
import type { BroadcastQuality, EndLiveResponse, LiveQuota } from '@/lib/live/types';
import {
  clampQuality,
  DEFAULT_QUALITY,
  DEGRADED_MAX_QUALITY,
  isQualityAllowed,
  lowerQuality,
} from '@/lib/live/constants';
import { DEFAULT_FILTER_ID, type FilterId } from '@/lib/live/cameraFilters';
import type { Room } from '@/lib/live/livekitClient';
import { CreatorPageShell } from '@/components/creator/CreatorPageShell';
import { QuotaBlockedNotice } from '@/components/creator/QuotaBlockedNotice';
import { CameraPreview } from '@/components/live/CameraPreview';
import {
  EMPTY_DRAFT,
  GoLiveSetupForm,
  validateDraft,
  type GoLiveDraft,
} from '@/components/live/GoLiveSetupForm';
import { CreatorBroadcaster } from '@/components/live/CreatorBroadcaster';
import { EndLiveConfirm } from '@/components/live/EndLiveConfirm';
import { LiveChat } from '@/components/live/LiveChat';
import { LiveStatsBar, useElapsedSeconds } from '@/components/live/LiveStatsBar';

/** What the create call gave us, plus the two things it does not return. */
interface ActiveBroadcast {
  liveSessionId: string;
  wsUrl: string;
  /** SECURITY: a LiveKit room credential. Kept in memory only. */
  token: string;
  quality: BroadcastQuality;
  maxViewers: number;
  /**
   * When the row was created, not when LiveKit connected.
   *
   * The backend writes `started_at = now()` at insert but does not return it,
   * and it is what live-end-session bills the duration against — so the timer
   * on screen is anchored to the moment the response arrived, which is that
   * instant plus a round trip. Close enough for a clock the creator reads;
   * the summary's number still comes from the server.
   */
  startedAt: string;
}

export default function CreatorLivePage() {
  const { ready } = useRequireAuth();
  const profile = useCreatorProfile();

  if (!ready) return <AuthPending />;

  if (profile.loading) {
    return (
      <CreatorPageShell title="ไลฟ์สด" width="wide">
        <div className="h-96 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      </CreatorPageShell>
    );
  }

  if (!profile.creatorId) {
    return (
      <CreatorPageShell title="ไลฟ์สด" width="wide">
        <NotACreatorNotice error={profile.error} />
      </CreatorPageShell>
    );
  }

  return (
    <LiveStudio
      creatorId={profile.creatorId}
      creatorName={profile.displayName?.trim() || 'ผู้ถ่ายทอด'}
    />
  );
}

function LiveStudio({ creatorId, creatorName }: { creatorId: string; creatorName: string }) {
  const router = useRouter();
  const platform = usePlatformStatus();

  const [draft, setDraft] = useState<GoLiveDraft>(EMPTY_DRAFT);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [deviceId, setDeviceId] = useState('');
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraReady, setCameraReady] = useState(false);
  /**
   * The camera look, held here rather than in either component that shows it.
   *
   * CameraPreview unmounts the moment the broadcast starts — it has to, it is
   * holding the camera — so a look chosen on the setup screen would be lost on
   * the way to CreatorBroadcaster if it lived down there. This is the shared
   * state the brief asks for; it is one useState, not a store.
   */
  const [filterId, setFilterId] = useState<FilterId>(DEFAULT_FILTER_ID);

  const [quota, setQuota] = useState<LiveQuota | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(true);

  const [broadcast, setBroadcast] = useState<ActiveBroadcast | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [viewers, setViewers] = useState({ current: 0, peak: 0 });

  const [endOpen, setEndOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [summary, setSummary] = useState<EndLiveResponse | null>(null);

  const elapsedSeconds = useElapsedSeconds(broadcast?.startedAt ?? null);
  const errors = validateDraft(draft);

  /**
   * The quality cap actually in force, and the quality that will be sent.
   *
   * Derived at render rather than written back into `draft`: a 'degraded' that
   * clears while the form is open should give the creator their 720p back,
   * and an effect that overwrote the draft would have thrown their choice
   * away. `effectiveQuality` is what the select shows and what go-live sends,
   * so the two cannot disagree.
   */
  const qualityDegraded = isDegraded(platform.status);
  const tierMaxQuality = quota?.maxQuality ?? null;
  const maxQuality = qualityDegraded
    ? lowerQuality(tierMaxQuality ?? DEGRADED_MAX_QUALITY, DEGRADED_MAX_QUALITY)
    : tierMaxQuality;
  const effectiveQuality = maxQuality ? clampQuality(draft.quality, maxQuality) : draft.quality;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        if (!cancelled) setQuotaLoading(false);
        return;
      }

      const { quota: result } = await fetchLiveQuota(supabase, creatorId);
      if (cancelled) return;

      setQuota(result);
      setQuotaLoading(false);

      // Drop the default quality to the tier cap rather than letting the
      // backend clamp it silently: a creator who never touched the dropdown
      // should still see the quality they are about to get.
      if (result && !isQualityAllowed(DEFAULT_QUALITY, result.maxQuality)) {
        setDraft((current) =>
          current.quality === DEFAULT_QUALITY ? { ...current, quality: result.maxQuality } : current,
        );
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [creatorId]);

  /**
   * The tab-close warning.
   *
   * It cannot end the session — unload handlers are not guaranteed to run and
   * cannot await a round trip — so the copy says what is true: closing the tab
   * does not close the live, and "จบไลฟ์" is what does. A session left open
   * keeps billing until someone ends it.
   */
  useEffect(() => {
    if (!broadcast || summary) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome ignores the string and shows its own copy; assigning
      // returnValue is still what triggers the dialog at all.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [broadcast, summary]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || submitting || !cameraReady) return;

    setSubmitting(true);
    setSubmitError(null);

    let supabase;
    try {
      supabase = getBrowserSupabase();
    } catch {
      setSubmitError('ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง');
      setSubmitting(false);
      return;
    }

    const cover = draft.coverImageUrl.trim();
    const { data, error } = await createLiveSession(supabase, {
      title: draft.title.trim(),
      access_level: draft.visibility,
      broadcast_quality: effectiveQuality,
      // Recording stays off: LiveKit egress is not wired, so a session flagged
      // for recording produces nothing (non-negotiable #5).
      recording_enabled: false,
      ...(draft.description.trim() !== '' ? { description: draft.description.trim() } : {}),
      ...(cover !== '' ? { cover_image_url: cover } : {}),
      // Sent only when PPV is actually reachable — the same gate the upload
      // flow applies, for the same reason (see GoLiveSetupForm's header).
      ...(CREATOR_PPV_ENABLED && draft.visibility === 'ppv' && draft.ppvPrice !== ''
        ? { ppv_price_stars: Number(draft.ppvPrice) }
        : {}),
    });

    if (error || !data) {
      console.error('[creator/live] create failed', error);
      setSubmitError(error?.message ?? 'เริ่มไลฟ์ไม่สำเร็จ กรุณาลองใหม่');
      setSubmitting(false);
      return;
    }

    setBroadcast({
      liveSessionId: data.live_session_id,
      wsUrl: data.ws_url,
      token: data.access_token,
      quality: data.broadcast_quality,
      maxViewers: data.max_viewers,
      startedAt: new Date().toISOString(),
    });
    setSubmitting(false);
  };

  const confirmEnd = async () => {
    if (!broadcast || ending) return;
    setEnding(true);
    setEndError(null);

    let supabase;
    try {
      supabase = getBrowserSupabase();
    } catch {
      setEndError('ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง');
      setEnding(false);
      return;
    }

    const { data, error } = await endLiveSession(supabase, broadcast.liveSessionId);

    if (error || !data) {
      console.error('[creator/live] end failed', error);
      // The room is left connected: a failed end means the session is still
      // open on the server, and disconnecting here would take the broadcast
      // off air while the row still says it is running.
      setEndError(error?.message ?? 'จบไลฟ์ไม่สำเร็จ กรุณาลองใหม่');
      setEnding(false);
      return;
    }

    // Dropping `broadcast` unmounts CreatorBroadcaster, whose cleanup
    // disconnects the room — so the LiveKit teardown follows the server's
    // confirmation rather than racing it.
    setSummary(data);
    setBroadcast(null);
    setRoom(null);
    setEnding(false);
  };

  const handleViewerCount = useCallback((current: number, peak: number) => {
    setViewers({ current, peak });
  }, []);

  if (broadcast || summary) {
    return (
      <BroadcastingLayout
        broadcast={broadcast}
        room={room}
        videoDeviceId={deviceId || undefined}
        micEnabled={micEnabled}
        filterId={filterId}
        onFilterIdChange={setFilterId}
        creatorName={creatorName}
        viewers={viewers}
        elapsedSeconds={elapsedSeconds}
        onRoomChange={setRoom}
        onViewerCountChange={handleViewerCount}
        onEndRequest={() => setEndOpen(true)}
        endDialog={
          endOpen || summary ? (
            <EndLiveConfirm
              summary={summary}
              ending={ending}
              error={endError}
              onConfirm={() => void confirmEnd()}
              onCancel={() => setEndOpen(false)}
              onDone={() => router.push('/dashboard')}
            />
          ) : null
        }
      />
    );
  }

  /**
   * Why this creator cannot go live at all, if anything.
   *
   * When it is set the setup form is not rendered — which also means the
   * camera is never opened, so a creator who cannot broadcast is not asked
   * for a camera permission first. A failed quota read leaves this null: the
   * backend runs the same check and refuses in Thai if it has to, and being
   * unable to read a counter is not a reason to stop someone.
   */
  const goliveBlock =
    // The platform kill switch outranks the creator's own quota, for the same
    // reason as on /creator/upload. check_creator_can_golive refuses on these
    // two statuses as well, but the view's message is the one ops can reword.
    describePlatformBlock(platform.status, 'live') ??
    (quota ? describeGoliveBlock(quota) : null);
  return (
    <CreatorPageShell
      title="ไลฟ์สด"
      subtitle="ตรวจสอบกล้องและไมโครโฟน แล้วเริ่มถ่ายทอดสดได้เลย"
      width="wide"
      action={
        <Link
          href="/creator/posts"
          className="inline-flex min-h-11 items-center rounded-xl border border-white/12 bg-white/[0.04] px-4 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          โพสต์ของฉัน
        </Link>
      }
    >
      {quotaLoading || platform.loading ? (
        <div className="h-96 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      ) : goliveBlock ? (
        <QuotaBlockedNotice
          kind={goliveBlock.kind}
          title={goliveBlock.title}
          message={goliveBlock.message}
          showUpgrade={goliveBlock.showUpgrade}
        />
      ) : (
        <form onSubmit={handleSubmit} noValidate className="grid gap-6 lg:grid-cols-5">
          <div className="min-w-0 lg:col-span-3">
            <CameraPreview
              quality={effectiveQuality}
              deviceId={deviceId}
              onDeviceIdChange={setDeviceId}
              micEnabled={micEnabled}
              onMicEnabledChange={setMicEnabled}
              filterId={filterId}
              onFilterIdChange={setFilterId}
              onReadyChange={setCameraReady}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-white/35">
              แนะนำให้ไลฟ์จากคอมพิวเตอร์ — การไลฟ์จากเบราว์เซอร์บนมือถืออาจใช้งานไม่ได้ในบางเครื่อง
            </p>
          </div>

          <div className="min-w-0 lg:col-span-2">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
              <GoLiveSetupForm
                // The clamped quality is what the select shows; onChange still
                // writes the creator's own pick back to the draft, so a
                // 'degraded' that clears gives them their 720p back.
                value={{ ...draft, quality: effectiveQuality }}
                onChange={setDraft}
                errors={showErrors ? errors : {}}
                quota={quota}
                quotaLoading={quotaLoading}
                maxQuality={maxQuality}
                qualityDegraded={qualityDegraded}
                submitting={submitting}
                cameraReady={cameraReady}
                submitError={submitError}
              />
            </div>
          </div>
        </form>
      )}
    </CreatorPageShell>
  );
}

/**
 * The broadcasting state: video on the left, chat and stats on the right.
 *
 * 100dvh rather than min-h-dvh — this is a cockpit, not a document, and the
 * page must not scroll away from the end button. `dvh` is what makes that hold
 * on iOS Safari, where the URL bar changes the viewport height mid-broadcast.
 */
function BroadcastingLayout({
  broadcast,
  room,
  videoDeviceId,
  micEnabled,
  filterId,
  onFilterIdChange,
  creatorName,
  viewers,
  elapsedSeconds,
  onRoomChange,
  onViewerCountChange,
  onEndRequest,
  endDialog,
}: {
  broadcast: ActiveBroadcast | null;
  room: Room | null;
  /** The camera picked on the setup screen. */
  videoDeviceId?: string;
  /** The mic toggle's state when the creator pressed go-live. */
  micEnabled: boolean;
  /** The look picked on the setup screen, still changeable mid-broadcast. */
  filterId: FilterId;
  onFilterIdChange: (id: FilterId) => void;
  creatorName: string;
  viewers: { current: number; peak: number };
  elapsedSeconds: number;
  onRoomChange: (room: Room | null) => void;
  onViewerCountChange: (current: number, peak: number) => void;
  onEndRequest: () => void;
  endDialog: React.ReactNode;
}) {
  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-[#0a0a15] text-white">
      <div className="safe-x safe-top grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        <div className="flex min-h-0 flex-col">
          {broadcast ? (
            <CreatorBroadcaster
              liveSessionId={broadcast.liveSessionId}
              wsUrl={broadcast.wsUrl}
              token={broadcast.token}
              quality={broadcast.quality}
              videoDeviceId={videoDeviceId}
              micEnabled={micEnabled}
              elapsedSeconds={elapsedSeconds}
              filterId={filterId}
              onFilterIdChange={onFilterIdChange}
              onRoomChange={onRoomChange}
              onViewerCountChange={onViewerCountChange}
            />
          ) : (
            // The session has ended and the summary dialog is on top of this.
            <div className="grid min-h-0 flex-1 place-items-center rounded-2xl border border-white/10 bg-black/40">
              <Loader2 size={26} className="animate-spin text-white/30" aria-hidden />
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <LiveStatsBar
            viewerCount={viewers.current}
            peakViewerCount={viewers.peak}
            elapsedSeconds={elapsedSeconds}
            tipStars={0}
            quality={broadcast?.quality ?? null}
            maxViewers={broadcast?.maxViewers ?? null}
          />
          {/* On a phone this drops under the video as the second row of the
              single-column grid, which is the bottom-sheet position without a
              sheet to drag. min-h keeps it usable when the video is tall. */}
          <LiveChat room={room} senderName={creatorName} isCreator className="min-h-48 flex-1" />
        </div>
      </div>

      <div className="safe-x safe-bottom flex shrink-0 items-center justify-end gap-3 border-t border-white/8 bg-black/40 px-3 py-3">
        <button
          type="button"
          onClick={onEndRequest}
          disabled={!broadcast}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-rose-500 to-pink-500 px-6 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-rose-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
        >
          จบไลฟ์
        </button>
      </div>

      {endDialog}
    </main>
  );
}

/**
 * A signed-in user with no `creators` row cannot go live: `getAuthedCreator`
 * in the Edge Function resolves creator_id from that row and answers 401
 * without it. Saying so beats letting them fill in a form that cannot submit.
 */
function NotACreatorNotice({ error }: { error: string | null }) {
  if (error) {
    return (
      <div role="alert" className="rounded-2xl border border-rose-400/25 bg-rose-500/10 p-6 text-sm text-rose-100">
        {error}
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center backdrop-blur-xl">
      <p className="text-base font-semibold text-white">คุณยังไม่ได้เป็น Creator</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/55">
        การไลฟ์สดเปิดให้เฉพาะบัญชี Creator ที่ผ่านการตรวจสอบแล้ว
      </p>
      <Link
        href="/creator/apply"
        className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        สมัครเป็น Creator
      </Link>
    </div>
  );
}
