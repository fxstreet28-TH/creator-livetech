'use client';

/**
 * /creator/upload — pick a video, describe it, send it straight to Bunny.
 *
 * The file never touches our servers: `content-request-video-upload` reserves
 * a Bunny Stream video and hands back a signature scoped to that one video,
 * creates the draft feed_posts row, then the browser streams the bytes to
 * Bunny's TUS endpoint directly and the Bunny webhook publishes the post when
 * encoding finishes. So this page owns exactly four things — the quota and
 * platform-status gates, validation before the request, the progress of the
 * upload, and not letting the creator walk away mid-upload.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Upload } from 'lucide-react';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useCreatorProfile } from '@/lib/hooks/useCreatorProfile';
import { useCreatorQuota } from '@/lib/hooks/useCreatorQuota';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { requestVideoUpload, type ContentError } from '@/lib/creator/api';
import { thaiForUploadError, uploadWithTus, UPLOAD_ABORTED } from '@/lib/creator/uploader';
import {
  aspectRatioForDimensions,
  postTypeForDuration,
} from '@/lib/creator/constants';
import { formatDuration } from '@/lib/creator/format';
import type { UploadRequestPayload } from '@/lib/creator/types';
import { CREATOR_PPV_ENABLED } from '@/lib/features';
import { describeUploadBlock } from '@/lib/creator/quota';
import { CreatorPageShell } from '@/components/creator/CreatorPageShell';
import { QuotaBlockedNotice } from '@/components/creator/QuotaBlockedNotice';
import { UploadDropzone, type SelectedVideo } from '@/components/creator/UploadDropzone';
import { UploadProgressCard, type UploadPhase } from '@/components/creator/UploadProgressCard';
import {
  EMPTY_METADATA,
  PostMetadataForm,
  validateMetadata,
  type PostMetadata,
  type PostMetadataErrors,
} from '@/components/creator/PostMetadataForm';

export default function CreatorUploadPage() {
  const { ready } = useRequireAuth();
  const profile = useCreatorProfile();
  const quota = useCreatorQuota(profile.creatorId);

  const [video, setVideo] = useState<SelectedVideo | null>(null);
  const [metadata, setMetadata] = useState<PostMetadata>(EMPTY_METADATA);
  const [showErrors, setShowErrors] = useState(false);

  const [phase, setPhase] = useState<UploadPhase | null>(null);
  const [percent, setPercent] = useState(0);
  const [retry, setRetry] = useState<{ attempt: number; max: number } | null>(null);
  const [postId, setPostId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; quotaRelated: boolean } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const errors: PostMetadataErrors = validateMetadata(metadata);
  const metadataValid = Object.keys(errors).length === 0;
  const canSubmit = video !== null && metadataValid && phase === null;

  /**
   * Why this creator cannot upload at all right now, if anything.
   *
   * A failed quota read is NOT a block: the backend runs the same check and
   * refuses in Thai if it has to, so a creator is never stopped by our
   * inability to read a counter. Same reasoning as the go-live form's
   * QuotaNotice.
   */
  const quotaBlock = quota.snapshot ? describeUploadBlock(quota.snapshot) : null;

  // Uploading is the only phase worth guarding: before it there is nothing to
  // lose, and after it the bytes are already at Bunny. The listener is added
  // and removed with the phase rather than kept for the page's lifetime, so a
  // creator who has not started an upload never sees the browser's dialog.
  const uploadInFlight = phase === 'requesting' || phase === 'uploading';
  useEffect(() => {
    if (!uploadInFlight) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome ignores the string and shows its own copy; assigning
      // returnValue is still what triggers the dialog at all.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [uploadInFlight]);

  // A creator who navigates away with the in-app router (which beforeunload
  // cannot see) should not leave TUS pushing a gigabyte in the background.
  useEffect(() => () => abortRef.current?.abort(), []);

  const startUpload = useCallback(
    async (selected: SelectedVideo, meta: PostMetadata) => {
      setFailure(null);
      setPercent(0);
      setRetry(null);
      setPhase('requesting');

      const controller = new AbortController();
      abortRef.current = controller;

      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        setFailure({ message: 'ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง', quotaRelated: false });
        setPhase('error');
        return;
      }

      const durationSeconds = Math.round(selected.durationSeconds);
      const payload: UploadRequestPayload = {
        title: meta.title.trim(),
        post_type: postTypeForDuration(durationSeconds),
        duration_seconds: durationSeconds,
        aspect_ratio: aspectRatioForDimensions(selected.width, selected.height),
        access_level: meta.visibility,
        ...(meta.description.trim() !== '' ? { description: meta.description.trim() } : {}),
        // Sent only when PPV is actually reachable; the deployed backend drops
        // it either way (see CREATOR_PPV_ENABLED in lib/features.ts).
        ...(CREATOR_PPV_ENABLED && meta.visibility === 'ppv' && meta.ppvPrice !== ''
          ? { ppv_price_stars: Number(meta.ppvPrice) }
          : {}),
      };

      const { data, error } = await requestVideoUpload(supabase, payload);

      if (error || !data) {
        const contentError: ContentError = error ?? {
          code: 'internal_error',
          message: 'เกิดข้อผิดพลาด กรุณาลองใหม่',
        };
        console.error('[creator/upload] request-video-upload failed', contentError);
        setFailure({
          message: contentError.message,
          quotaRelated: contentError.quotaRelated === true,
        });
        setPhase('error');
        return;
      }

      // The draft row exists from here on, so the creator can reach the post
      // even if the upload then fails.
      setPostId(data.post_id);
      setPhase('uploading');

      try {
        await uploadWithTus({
          file: selected.file,
          endpoint: data.tus_upload_endpoint,
          // Verbatim, both of them. SECURITY: tus_headers carries the
          // per-video signature — it is never logged and never stored.
          headers: data.tus_headers,
          metadata: data.tus_metadata,
          onProgress: (bytes, total) => {
            // Bytes are moving again, so whatever resume was in flight is over.
            setRetry(null);
            setPercent(total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : 0);
          },
          onRetry: (attempt, max) => setRetry({ attempt, max }),
          signal: controller.signal,
        });
        setRetry(null);
        setPhase('success');
      } catch (err) {
        setRetry(null);
        if (err instanceof Error && err.message === UPLOAD_ABORTED) {
          // Back to the form with the file and the metadata still in place —
          // cancelling an upload is not the same as discarding the work.
          setPhase(null);
          setPercent(0);
          return;
        }
        // The error object carries the failed request; log the mapped status
        // only, never the object, because its request headers hold the
        // upload signature.
        console.error('[creator/upload] bunny TUS upload failed');
        setFailure({ message: thaiForUploadError(err), quotaRelated: false });
        setPhase('error');
      }
    },
    [],
  );

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setShowErrors(true);
    if (!video || !metadataValid || phase !== null) return;
    void startUpload(video, metadata);
  };

  /**
   * "ลองใหม่" after a failure starts the whole flow again, including a fresh
   * `content-request-video-upload`.
   *
   * This is required now, not merely convenient: the TUS signature expires
   * (~1 hour) and is bound to the video it was minted for, so a failure that
   * happened because it expired can only be answered with a new one. Reusing
   * the old headers would fail identically every time.
   *
   * It leaves the first draft row behind with video_status 'pending' — the
   * creator can delete it from /creator/posts, and the backend's orphan
   * cleanup handles the Bunny side.
   * TODO(post-launch): retry against the existing draft once the backend can
   * re-sign an upload for an existing post_id.
   */
  const retryFromScratch = () => {
    if (!video) return;
    void startUpload(video, metadata);
  };

  const startOver = () => {
    abortRef.current?.abort();
    setPhase(null);
    setPercent(0);
    setRetry(null);
    setFailure(null);
    setPostId(null);
  };

  const resetForNextVideo = () => {
    startOver();
    setVideo(null);
    setMetadata(EMPTY_METADATA);
    setShowErrors(false);
  };

  if (!ready) return <AuthPending />;

  return (
    <CreatorPageShell
      title="อัปโหลดวิดีโอ"
      subtitle="อัปโหลดคลิปของคุณ แล้วระบบจะประมวลผลให้อัตโนมัติ"
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
      {profile.loading || quota.loading ? (
        <div className="h-64 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      ) : !profile.creatorId ? (
        <NotACreatorNotice error={profile.error} />
      ) : phase !== null && video ? (
        <UploadProgressCard
          phase={phase}
          fileName={video.file.name}
          fileSizeBytes={video.file.size}
          durationLabel={formatDuration(video.durationSeconds)}
          percent={percent}
          retry={retry}
          errorMessage={failure?.message ?? null}
          showPlanUpgrade={failure?.quotaRelated ?? false}
          postId={postId}
          onCancel={() => abortRef.current?.abort()}
          onRetry={retryFromScratch}
          onStartOver={phase === 'success' ? resetForNextVideo : startOver}
        />
      ) : quotaBlock ? (
        // Checked after the progress card, so an upload that filled the last
        // slot still shows its own success state instead of being replaced by
        // the wall it just created.
        <QuotaBlockedNotice
          kind={quotaBlock.kind}
          title={quotaBlock.title}
          message={quotaBlock.message}
          showUpgrade={quotaBlock.showUpgrade}
        />
      ) : (
        <form onSubmit={handleSubmit} noValidate className="grid gap-6 lg:grid-cols-5">
          {/* 3/5 + 2/5 ≈ the 60/40 split the brief asks for, and it collapses
              to a single column below lg without a second breakpoint. */}
          <div className="min-w-0 lg:col-span-3">
            <UploadDropzone selected={video} onSelect={setVideo} />
          </div>

          <div className="min-w-0 lg:col-span-2">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
              <PostMetadataForm
                value={metadata}
                onChange={setMetadata}
                errors={showErrors ? errors : {}}
                footer={
                  <>
                    {showErrors && !video && (
                      <p role="alert" className="text-sm text-rose-300">
                        กรุณาเลือกไฟล์วิดีโอก่อน
                      </p>
                    )}
                    {/* Sticky at the bottom of the viewport on a phone, where
                        the form is long enough that the button would otherwise
                        sit below the fold behind the keyboard. */}
                    <div className="sticky bottom-0 -mx-5 -mb-5 rounded-b-2xl bg-[#0a0a15]/85 px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-4 backdrop-blur lg:static lg:mx-0 lg:mb-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
                      <button
                        type="submit"
                        disabled={!canSubmit}
                        className="inline-flex min-h-[3.25rem] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-purple-500 to-cyan-400 px-5 py-4 text-base font-extrabold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none"
                      >
                        <Upload size={18} aria-hidden />
                        อัปโหลดวิดีโอ
                      </button>
                    </div>
                  </>
                }
              />
            </div>
          </div>
        </form>
      )}
    </CreatorPageShell>
  );
}

/**
 * A signed-in user with no `creators` row cannot upload: every content
 * endpoint resolves creator_id from that row and answers 401 without it.
 * Saying so is better than letting them fill in a form that cannot submit.
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
        การอัปโหลดวิดีโอเปิดให้เฉพาะบัญชี Creator ที่ผ่านการตรวจสอบแล้ว
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
