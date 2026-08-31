/**
 * Client-side bounds for the creator upload flow.
 *
 * Same contract as lib/constants/stars.ts: these are duplicated from the
 * backend on purpose, because a form that only learns a rule from a rejected
 * round trip is a worse form. The backend
 * (`check_creator_can_upload` + the feed_posts CHECK constraints) remains the
 * authority — drift here costs a confusing message, never a bad row.
 */

import type { AspectRatio, CreatorVisibility, VideoPostType } from './types';

/** MIME types the dropzone accepts, for both the `accept` attr and the check. */
export const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;

/** `accept` attribute value. .mov is included by extension: Windows Chrome
 *  reports some QuickTime files with an empty type. */
export const FILE_INPUT_ACCEPT = `${ACCEPTED_VIDEO_TYPES.join(',')},.mp4,.mov,.webm`;

/** Extension fallback for browsers that hand us an empty File.type. */
export const ACCEPTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm'] as const;

/** 2 GB. Bunny accepts more; this is our own ceiling for a browser PUT. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** feed_posts.title is free text; 3..80 keeps list cards readable. */
export const MIN_TITLE_LENGTH = 3;
export const MAX_TITLE_LENGTH = 80;

/** feed_posts.content, used as the description on video posts. */
export const MAX_DESCRIPTION_LENGTH = 500;

/**
 * The short/long boundary.
 *
 * The backend has no such rule — `check_creator_can_upload` only branches on
 * `video_long` to enforce `can_upload_long_form` (false on the free tier), and
 * nothing anywhere defines where a short ends. 60s is the platform convention
 * everywhere else, so the client picks it and the backend enforces the tier.
 */
export const SHORT_MAX_SECONDS = 60;

/** Derive the post_type the upload endpoint requires from the probed duration. */
export function postTypeForDuration(durationSeconds: number): VideoPostType {
  return durationSeconds <= SHORT_MAX_SECONDS ? 'video_short' : 'video_long';
}

/** Derive aspect_ratio from the probed video dimensions. */
export function aspectRatioForDimensions(width: number, height: number): AspectRatio {
  if (!width || !height) return '16:9';
  const ratio = width / height;
  if (ratio > 1.15) return '16:9';
  if (ratio < 0.87) return '9:16';
  return '1:1';
}

/** PPV price bounds, per the sprint brief. Not yet enforced anywhere else. */
export const MIN_PPV_PRICE_STARS = 1;
export const MAX_PPV_PRICE_STARS = 200;

/**
 * Internal reference rate used only to show viewers' PPV price in baht.
 *
 * Deliberately NOT the wallet's purchase rate (11.00 THB/star, from
 * star_pricing_config) — this is the internal content-pricing rate from the
 * sprint brief, and it is display-only: no money is computed from it.
 */
export const PPV_THB_PER_STAR = 10;

/**
 * How often the post screens re-read a post that is still encoding, and for
 * how long.
 *
 * Polling rather than Supabase Realtime: `feed_posts` is not in the
 * `supabase_realtime` publication (only `stars_wallet` and `messages` are), so
 * the wallet's realtime pattern from PR #28 would subscribe successfully and
 * then never fire. Bunny takes 2-5 minutes, so a 10s poll for 10 minutes
 * covers the encode without leaving a timer running on an idle tab.
 * TODO(day-9): drop this if feed_posts is added to the publication.
 */
export const ENCODING_POLL_MS = 10_000;
export const ENCODING_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** Video statuses that mean "Bunny still has work to do". */
export const IN_PROGRESS_VIDEO_STATUSES = ['pending', 'uploading', 'processing'] as const;

export interface VisibilityOption {
  value: CreatorVisibility;
  /** Rendered as text, not as an icon font — emoji carry their own colour. */
  emoji: string;
  label: string;
  /** One line under the label in the segmented control. */
  hint: string;
}

/** The three choices on the upload/edit forms, in the order they render. */
export const VISIBILITY_OPTIONS: VisibilityOption[] = [
  { value: 'public', emoji: '🌍', label: 'สาธารณะ', hint: 'ใครก็ดูได้' },
  { value: 'subscribers', emoji: '💜', label: 'สำหรับสมาชิก', hint: 'เฉพาะสมาชิกของคุณ' },
  { value: 'ppv', emoji: '⭐', label: 'ปลดล็อก', hint: 'จ่ายด้วย Stars เพื่อดู' },
];

/** Short label for any access_level, including ones this UI cannot set. */
export function visibilityLabel(accessLevel: string | null | undefined): string {
  switch (accessLevel) {
    case 'public':
      return 'สาธารณะ';
    case 'subscribers':
      return 'สำหรับสมาชิก';
    case 'ppv':
      return 'ปลดล็อก (PPV)';
    case 'free_preview':
      return 'ตัวอย่างฟรี';
    default:
      return 'ไม่ระบุ';
  }
}

export function visibilityEmoji(accessLevel: string | null | undefined): string {
  switch (accessLevel) {
    case 'public':
      return '🌍';
    case 'subscribers':
      return '💜';
    case 'ppv':
      return '⭐';
    case 'free_preview':
      return '👀';
    default:
      return '❔';
  }
}
