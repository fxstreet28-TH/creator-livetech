'use client';

/**
 * What the upload screen becomes once the TUS upload to Bunny starts: the
 * file, a progress bar, and the one control that matters mid-upload — cancel.
 *
 * Also renders the two terminal states, because they are the same card with
 * the same file in it. Swapping to a different component on completion would
 * throw away the context the creator is looking at.
 */

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import { formatFileSize } from '@/lib/creator/format';

export type UploadPhase = 'requesting' | 'uploading' | 'success' | 'error';

interface UploadProgressCardProps {
  phase: UploadPhase;
  fileName: string;
  fileSizeBytes: number;
  durationLabel: string;
  /** 0-100. */
  percent: number;
  /**
   * Set while TUS is resuming after a dropped chunk, cleared once bytes move
   * again. The creator is told rather than left watching a bar that stopped:
   * a resume can wait 20s before its last attempt.
   */
  retry?: { attempt: number; max: number } | null;
  /** Thai, already localised. Only read in the 'error' phase. */
  errorMessage?: string | null;
  /** Set when the failure is a quota/tier refusal, so we can offer the link. */
  showPlanUpgrade?: boolean;
  /** Present from the moment the draft row exists. */
  postId?: string | null;
  onCancel: () => void;
  onRetry: () => void;
  onStartOver: () => void;
}

export function UploadProgressCard({
  phase,
  fileName,
  fileSizeBytes,
  durationLabel,
  percent,
  retry,
  errorMessage,
  showPlanUpgrade = false,
  postId,
  onCancel,
  onRetry,
  onStartOver,
}: UploadProgressCardProps) {
  const uploadedBytes = Math.min(fileSizeBytes, Math.round((percent / 100) * fileSizeBytes));

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-all text-sm font-semibold text-white">{fileName}</p>
          <p className="mt-1 text-xs text-white/50">
            {formatFileSize(fileSizeBytes)} · {durationLabel}
          </p>
        </div>
        {phase === 'uploading' && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-white/12 px-3 text-sm text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <X size={15} aria-hidden />
            ยกเลิก
          </button>
        )}
      </div>

      {(phase === 'requesting' || phase === 'uploading') && (
        <div className="mt-5">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase === 'uploading' ? percent : undefined}
            aria-label="ความคืบหน้าการอัปโหลด"
            className="h-2.5 w-full overflow-hidden rounded-full bg-white/10"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-purple-500 to-cyan-400 transition-[width] duration-200 ease-out"
              style={{ width: `${phase === 'uploading' ? percent : 3}%` }}
            />
          </div>

          <div className="mt-2 flex items-center justify-between text-xs text-white/55">
            <span role="status">
              {phase === 'requesting'
                ? 'กำลังเตรียมการอัปโหลด...'
                : retry
                  ? `กำลังเชื่อมต่อใหม่... (${retry.attempt}/${retry.max})`
                  : 'กำลังอัปโหลด...'}
            </span>
            <span className="tabular-nums">
              {phase === 'uploading'
                ? `${formatFileSize(uploadedBytes)} / ${formatFileSize(fileSizeBytes)} · ${percent}%`
                : ''}
            </span>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-white/35">
            {retry
              ? 'การเชื่อมต่อขัดข้อง ระบบกำลังอัปโหลดต่อจากจุดเดิม ไม่ต้องเริ่มใหม่'
              : 'อย่าปิดหน้านี้จนกว่าการอัปโหลดจะเสร็จ'}
          </p>
        </div>
      )}

      {phase === 'success' && (
        <div className="mt-5 flex flex-col items-center gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-6 text-center">
          <CheckCircle2 size={44} className="text-emerald-300" aria-hidden />
          <p className="text-base font-bold text-white" role="status">
            อัปโหลดสำเร็จ! กำลังประมวลผลวิดีโอ...
          </p>
          <p className="flex items-center gap-2 text-sm text-white/65">
            <Loader2 size={15} className="animate-spin" aria-hidden />
            วิดีโอจะพร้อมเผยแพร่ภายใน 2-5 นาที
          </p>

          <div className="mt-2 flex w-full flex-col gap-3 sm:flex-row">
            {postId && (
              <Link
                href={`/creator/posts/${postId}`}
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                ดูโพสต์
              </Link>
            )}
            <button
              type="button"
              onClick={onStartOver}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              อัปโหลดอีกวิดีโอ
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="mt-5 rounded-2xl border border-rose-400/25 bg-rose-500/10 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-rose-300" aria-hidden />
            <div className="min-w-0">
              <p role="alert" className="text-sm leading-relaxed text-rose-100">
                {errorMessage ?? 'อัปโหลดไม่สำเร็จ กรุณาลองใหม่'}
              </p>
              {showPlanUpgrade && (
                <Link
                  href="/settings/plan"
                  className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-purple-200 underline underline-offset-4 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                >
                  ดูแพ็กเกจและอัปเกรด
                </Link>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              ลองใหม่
            </button>
            <button
              type="button"
              onClick={onStartOver}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              กลับไปแก้ไขข้อมูล
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
