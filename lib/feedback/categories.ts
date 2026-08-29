/**
 * Category vocabulary for the customer feedback widget.
 *
 * The five ids and the five colours are NOT a front-end choice: they mirror
 * `CATEGORY_META` inside the deployed `send-feedback` Edge Function, which
 * uses the same colour as the left border and the eyebrow of the notification
 * email that lands in the AURUM inbox. Changing a colour here without changing
 * it there makes the widget and the email disagree about what a "bug report"
 * looks like; changing an id here breaks the request outright, because the
 * function answers anything outside this list with 400 invalid_category.
 *
 * Labels are Thai because every user-facing string on this site is (the root
 * layout is <html lang="th">). The emoji is part of the label, not an icon
 * asset — the floating button itself uses a real icon component.
 */

export type FeedbackCategory = 'feature' | 'bug' | 'feedback' | 'question' | 'other';

export interface FeedbackCategoryMeta {
  id: FeedbackCategory;
  /** Thai, user-facing. */
  label: string;
  emoji: string;
  /** Hex, shared with the notification email. Used for the selected pill. */
  color: string;
}

export const FEEDBACK_CATEGORIES: readonly FeedbackCategoryMeta[] = [
  { id: 'feature', label: 'ขอ feature ใหม่', emoji: '💡', color: '#8B5CF6' },
  { id: 'bug', label: 'แจ้งปัญหา', emoji: '🐛', color: '#DC2626' },
  { id: 'feedback', label: 'ความคิดเห็นทั่วไป', emoji: '💬', color: '#0EA5E9' },
  { id: 'question', label: 'คำถาม', emoji: '🙋', color: '#F59E0B' },
  { id: 'other', label: 'อื่นๆ', emoji: '📩', color: '#78716C' },
];

/** Pre-selected when the modal opens — the broadest of the five. */
export const DEFAULT_FEEDBACK_CATEGORY: FeedbackCategory = 'feedback';

/**
 * The only category that asks for a star rating. "How was your experience"
 * is a question about general feedback; asking it next to a bug report reads
 * as inviting the user to rate their own crash.
 */
export const RATED_FEEDBACK_CATEGORY: FeedbackCategory = 'feedback';

/**
 * Mirrors the function's own bounds. Enforced client-side so the disabled
 * submit button and the character counter agree with what the server would
 * answer (message_too_short / message_too_long), rather than letting the user
 * discover the limit by being rejected.
 */
export const FEEDBACK_MESSAGE_MIN = 5;
export const FEEDBACK_MESSAGE_MAX = 5000;
