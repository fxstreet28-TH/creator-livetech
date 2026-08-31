'use client';

/**
 * The one place that turns (publish_status, video_status) into a badge.
 *
 * Two columns, not one: `publish_status` says whether viewers can see the
 * post, `video_status` says whether Bunny has finished with the file, and
 * only the pair describes the state. A post is 'draft' + 'processing' for the
 * two to five minutes after an upload, and the Bunny webhook flips both at
 * once when encoding lands.
 */

import type { PublishStatus, VideoStatus } from '@/lib/creator/types';

export interface PostStatusBadgeProps {
  publishStatus: PublishStatus;
  videoStatus: VideoStatus | null;
  className?: string;
}

interface Badge {
  emoji: string;
  label: string;
  className: string;
}

export function postStatusBadge(
  publishStatus: PublishStatus,
  videoStatus: VideoStatus | null,
): Badge {
  // Video state wins while Bunny still owns the file: a "published" post whose
  // encode failed plays for nobody, and saying "เผยแพร่แล้ว" would be a lie.
  if (videoStatus === 'failed') {
    return { emoji: '🔴', label: 'ล้มเหลว', className: 'border-rose-400/30 bg-rose-500/12 text-rose-200' };
  }
  if (videoStatus === 'deleted') {
    return { emoji: '🔴', label: 'ถูกลบแล้ว', className: 'border-rose-400/25 bg-rose-500/10 text-rose-200/80' };
  }
  if (videoStatus === 'pending' || videoStatus === 'uploading' || videoStatus === 'processing') {
    return { emoji: '🟡', label: 'กำลังประมวลผล', className: 'border-amber-400/30 bg-amber-500/12 text-amber-200' };
  }

  switch (publishStatus) {
    case 'published':
      return { emoji: '🟢', label: 'เผยแพร่แล้ว', className: 'border-emerald-400/30 bg-emerald-500/12 text-emerald-200' };
    case 'scheduled':
      return { emoji: '⏰', label: 'ตั้งเวลาไว้', className: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-200' };
    case 'archived':
      return { emoji: '📦', label: 'เก็บถาวร', className: 'border-white/12 bg-white/[0.05] text-white/60' };
    case 'draft':
    default:
      return { emoji: '⚪', label: 'ฉบับร่าง', className: 'border-white/12 bg-white/[0.05] text-white/60' };
  }
}

export function PostStatusBadge({ publishStatus, videoStatus, className = '' }: PostStatusBadgeProps) {
  const badge = postStatusBadge(publishStatus, videoStatus);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${badge.className} ${className}`}
    >
      <span aria-hidden>{badge.emoji}</span>
      {badge.label}
    </span>
  );
}
