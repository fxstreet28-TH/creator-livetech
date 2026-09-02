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

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useCreatorProfile } from '@/lib/hooks/useCreatorProfile';
import { useDashboardUser } from '@/lib/hooks/useDashboardUser';
import { useLiveChannel } from '@/lib/hooks/useLiveChannel';
import { useCameraOrientation } from '@/lib/hooks/useCameraOrientation';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { CREATOR_PPV_ENABLED } from '@/lib/features';
import { createLiveSession, endLiveSession, fetchLiveQuota, thaiForQuotaRefusal } from '@/lib/live/api';
import type {
  BroadcastQuality,
  EndLiveResponse,
  LiveChatEntry,
  LiveDelivery,
  LiveQuota,
} from '@/lib/live/types';
import { DEFAULT_QUALITY, isQualityAllowed } from '@/lib/live/constants';
import { DEFAULT_FILTER_ID, type FilterId } from '@/lib/live/cameraFilters';
import type { CameraOrientation } from '@/lib/live/cameraOrientation';
import type { LiveChannelStatus } from '@/lib/live/realtime';
import type { FloatingReaction } from '@/lib/live/reactions';
import { CreatorPageShell } from '@/components/creator/CreatorPageShell';
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
   * Which pipeline is carrying this session.
   *
   * 'livekit' means the Bunny stream could not be created and the backend fell
   * back so the creator could still broadcast. The broadcaster skips the
   * egress call in that case — there is nothing to push to.
   */
  delivery: LiveDelivery;
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
  const { user } = useDashboardUser();

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
  /**
   * The two camera-orientation switches — unlike the look, remembered between
   * sessions. The hook owns the localStorage round trip; this page just passes
   * the value to both screens that show the camera.
   */
  const [orientation, setOrientation] = useCameraOrientation();

  const [quota, setQuota] = useState<LiveQuota | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(true);

  const [broadcast, setBroadcast] = useState<ActiveBroadcast | null>(null);

  const [endOpen, setEndOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [summary, setSummary] = useState<EndLiveResponse | null>(null);

  const elapsedSeconds = useElapsedSeconds(broadcast?.startedAt ?? null);
  const errors = validateDraft(draft);

  /**
   * The session's Realtime channel: the viewers' chat and reactions, and the
   * audience count.
   *
   * The creator is a participant in this channel but not in their own
   * audience — `isCreator` keeps them out of the count and marks their chat
   * lines for everyone else's 👑. Nothing about it depends on the video
   * pipeline, which is why it is the same channel a viewer opens.
   */
  const channel = useLiveChannel({
    sessionId: broadcast?.liveSessionId ?? null,
    userId: user?.id ?? null,
    displayName: creatorName,
    isCreator: true,
    creatorUserId: user?.id ?? null,
  });

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
      broadcast_quality: draft.quality,
      latency_mode: draft.latency,
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
      delivery: data.delivery,
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

    const { data, error } = await endLiveSession(
      supabase,
      broadcast.liveSessionId,
      channel.chatMessageCount,
    );

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
    setEnding(false);
  };

  if (broadcast || summary) {
    return (
      <BroadcastingLayout
        broadcast={broadcast}
        videoDeviceId={deviceId || undefined}
        micEnabled={micEnabled}
        filterId={filterId}
        onFilterIdChange={setFilterId}
        orientation={orientation}
        onOrientationChange={setOrientation}
        viewers={{ current: channel.viewerCount, peak: channel.peakViewerCount }}
        reactions={channel.reactions}
        chat={channel.chat}
        chatStatus={channel.status}
        onSendChat={channel.sendChat}
        elapsedSeconds={elapsedSeconds}
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

  const blockedReason =
    quota && !quota.canGolive ? thaiForQuotaRefusal(quota.reason) : null;

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
      <form onSubmit={handleSubmit} noValidate className="grid gap-6 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <CameraPreview
            quality={draft.quality}
            deviceId={deviceId}
            onDeviceIdChange={setDeviceId}
            micEnabled={micEnabled}
            onMicEnabledChange={setMicEnabled}
            filterId={filterId}
            onFilterIdChange={setFilterId}
            orientation={orientation}
            onOrientationChange={setOrientation}
            onReadyChange={setCameraReady}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-white/35">
            แนะนำให้ไลฟ์จากคอมพิวเตอร์ — การไลฟ์จากเบราว์เซอร์บนมือถืออาจใช้งานไม่ได้ในบางเครื่อง
          </p>
        </div>

        <div className="min-w-0 lg:col-span-2">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
            <GoLiveSetupForm
              value={draft}
              onChange={setDraft}
              errors={showErrors ? errors : {}}
              quota={quota}
              quotaLoading={quotaLoading}
              blockedReason={blockedReason}
              submitting={submitting}
              cameraReady={cameraReady}
              submitError={submitError}
            />
          </div>
        </div>
      </form>
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
  videoDeviceId,
  micEnabled,
  filterId,
  onFilterIdChange,
  orientation,
  onOrientationChange,
  viewers,
  reactions,
  chat,
  chatStatus,
  onSendChat,
  elapsedSeconds,
  onEndRequest,
  endDialog,
}: {
  broadcast: ActiveBroadcast | null;
  /** The camera picked on the setup screen. */
  videoDeviceId?: string;
  /** The mic toggle's state when the creator pressed go-live. */
  micEnabled: boolean;
  /** The look picked on the setup screen, still changeable mid-broadcast. */
  filterId: FilterId;
  onFilterIdChange: (id: FilterId) => void;
  /** The camera-orientation switches, restored from localStorage by the page. */
  orientation: CameraOrientation;
  onOrientationChange: (next: CameraOrientation) => void;
  viewers: { current: number; peak: number };
  reactions: FloatingReaction[];
  chat: LiveChatEntry[];
  chatStatus: LiveChannelStatus;
  onSendChat: (text: string) => Promise<void>;
  elapsedSeconds: number;
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
              delivery={broadcast.delivery}
              videoDeviceId={videoDeviceId}
              micEnabled={micEnabled}
              elapsedSeconds={elapsedSeconds}
              filterId={filterId}
              onFilterIdChange={onFilterIdChange}
              orientation={orientation}
              onOrientationChange={onOrientationChange}
              viewerCount={viewers.current}
              reactions={reactions}
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
          <LiveChat
            entries={chat}
            onSend={onSendChat}
            status={chatStatus}
            className="min-h-48 flex-1"
          />
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
