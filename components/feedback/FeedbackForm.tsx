'use client';

/**
 * The body of the feedback modal: category, optional rating, message, submit.
 *
 * Owns the draft and the inline error. It does not own the modal — the parent
 * decides what a success means (close, reset, toast), which is why the outcome
 * leaves through onSubmitted / onFailed rather than being handled in here.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  DEFAULT_FEEDBACK_CATEGORY,
  FEEDBACK_CATEGORIES,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  RATED_FEEDBACK_CATEGORY,
  type FeedbackCategory,
} from '@/lib/feedback/categories';
import { useSubmitFeedback, type FeedbackSuccess } from '@/lib/hooks/useSubmitFeedback';

/**
 * Auto-resize bounds, in pixels, for the message box.
 *
 * The spec is 4 rows minimum and 12 rows maximum. At the 14px font and 1.6
 * line-height set on the textarea that is 22.4px a row, plus 12px of padding
 * top and bottom and 1px of border on each side:
 *   min = 4 * 22.4 + 26 ≈ 116     max = 12 * 22.4 + 26 ≈ 295
 * Kept as pixels rather than a `rows` attribute because the height is written
 * from scrollHeight on every keystroke, and `rows` would only set the initial
 * value before the first measurement overwrote it.
 */
const TEXTAREA_MIN_PX = 116;
const TEXTAREA_MAX_PX = 295;

const BORDER = '#E7E5E4';
const GOLD = '#C9A961';
const INK = '#1A1614';
const MUTED = '#8A8579';

interface FeedbackFormProps {
  titleId: string;
  onSubmitted: (result: FeedbackSuccess) => void;
  onCancel: () => void;
}

export function FeedbackForm({ titleId, onSubmitted, onCancel }: FeedbackFormProps) {
  const [category, setCategory] = useState<FeedbackCategory>(DEFAULT_FEEDBACK_CATEGORY);
  const [rating, setRating] = useState<number | null>(null);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [message, setMessage] = useState('');

  const { submit, submitting, error, clearError } = useSubmitFeedback();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const trimmedLength = message.trim().length;
  const canSubmit = trimmedLength >= FEEDBACK_MESSAGE_MIN && !submitting;
  const showRating = category === RATED_FEEDBACK_CATEGORY;

  // Grow with the content between the two bounds above. Runs before paint so
  // the box never shows a scrollbar for one frame on the way to its new size.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(TEXTAREA_MAX_PX, Math.max(TEXTAREA_MIN_PX, el.scrollHeight));
    el.style.height = `${next}px`;
    // Only the capped box scrolls; below the cap the element is exactly as
    // tall as its text, so an `auto` overflow would still reserve a gutter in
    // some browsers.
    el.style.overflowY = el.scrollHeight > TEXTAREA_MAX_PX ? 'auto' : 'hidden';
  }, [message]);

  const handleCategoryChange = useCallback((next: FeedbackCategory) => {
    setCategory(next);
    clearError();
    // The stars only exist for one category. Carrying a rating over to a bug
    // report would submit a score the user can no longer see or change.
    if (next !== RATED_FEEDBACK_CATEGORY) {
      setRating(null);
      setHoverRating(null);
    }
  }, [clearError]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    const result = await submit({
      category,
      message: message.trim(),
      ...(showRating && rating ? { rating } : {}),
    });

    if (result) onSubmitted(result);
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <h2 id={titleId} className="text-[19px] font-bold leading-tight" style={{ color: INK }}>
        แชร์ความคิดเห็น
      </h2>
      <p className="mt-1 text-[13px]" style={{ color: MUTED }}>
        ช่วยเราปรับปรุง AURUM Live
      </p>

      {/* Category ---------------------------------------------------- */}
      <fieldset className="mt-6 min-w-0 border-0 p-0">
        <legend className="mb-2 text-[12px] font-semibold" style={{ color: INK }}>
          ประเภท
        </legend>
        <div className="flex flex-wrap gap-2">
          {FEEDBACK_CATEGORIES.map((item) => {
            const selected = item.id === category;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleCategoryChange(item.id)}
                aria-pressed={selected}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors"
                style={{
                  // Per-category colour cannot be a Tailwind class: the palette
                  // is shared with the email template, not with the theme.
                  borderColor: selected ? item.color : BORDER,
                  backgroundColor: selected ? `${item.color}14` : '#FFFFFF',
                  color: selected ? item.color : '#57534E',
                  fontWeight: selected ? 600 : 400,
                }}
              >
                <span aria-hidden>{item.emoji}</span>
                {item.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* Rating (general feedback only) ------------------------------- */}
      {showRating && (
        <fieldset className="mt-5 border-0 p-0">
          <legend className="mb-1 text-[12px] font-semibold" style={{ color: INK }}>
            ประสบการณ์การใช้งานเป็นอย่างไร?
          </legend>
          <div className="flex items-center" onMouseLeave={() => setHoverRating(null)}>
            {[1, 2, 3, 4, 5].map((value) => {
              const filled = value <= (hoverRating ?? rating ?? 0);
              return (
                <button
                  key={value}
                  type="button"
                  // Clicking the current rating clears it — the field is
                  // optional, so it has to be possible to get back to "unrated"
                  // after a misclick.
                  onClick={() => setRating(rating === value ? null : value)}
                  onMouseEnter={() => setHoverRating(value)}
                  onFocus={() => setHoverRating(value)}
                  onBlur={() => setHoverRating(null)}
                  aria-label={`ให้ ${value} ดาว`}
                  aria-pressed={rating === value}
                  className="grid h-11 w-11 place-items-center rounded-lg transition-transform hover:scale-110"
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden focusable="false">
                    <path
                      d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.35l-5.81 3.05 1.11-6.47-4.7-4.58 6.5-.95z"
                      fill={filled ? '#F59E0B' : '#EDEAE4'}
                      stroke={filled ? '#F59E0B' : '#DDD9D2'}
                      strokeWidth="1"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {/* Message ------------------------------------------------------ */}
      <div className="mt-5">
        <label htmlFor="feedback-message" className="mb-2 block text-[12px] font-semibold" style={{ color: INK }}>
          ข้อความ
        </label>
        <textarea
          id="feedback-message"
          ref={textareaRef}
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            clearError();
          }}
          // Hard-caps the field at the server's limit, so message_too_long is
          // unreachable rather than merely validated against.
          maxLength={FEEDBACK_MESSAGE_MAX}
          placeholder="แชร์ความคิดเห็น ปัญหา หรือคำแนะนำ..."
          aria-describedby="feedback-counter"
          disabled={submitting}
          className="aurum-feedback__textarea block w-full resize-none rounded-xl border px-3 py-3 text-[14px] leading-[1.6] outline-none"
          style={{ borderColor: BORDER, color: INK, minHeight: TEXTAREA_MIN_PX }}
        />
        <div id="feedback-counter" className="mt-1 text-right text-[11px] tabular-nums" style={{ color: MUTED }}>
          {message.length.toLocaleString('en-US')} / {FEEDBACK_MESSAGE_MAX.toLocaleString('en-US')}
        </div>
      </div>

      {/* Failures are reported here rather than in a toast: the modal stays
          open on every one of them, and on a small screen a fixed toast would
          sit on top of this form. Amber for "you have sent a lot of these
          lately", which is a limit that lifts on its own, and warm red for a
          failure the user is being asked to do something about. */}
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg px-3 py-2.5 text-[13px] leading-snug"
          style={
            error.status === 429
              ? { backgroundColor: '#FBF2E6', color: '#8A6224' }
              : { backgroundColor: '#FDF3F0', color: '#8A3D28' }
          }
        >
          {error.message}
        </p>
      )}

      {/* Actions ------------------------------------------------------ */}
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="min-h-11 rounded-xl px-4 text-[14px] transition-colors hover:bg-black/[0.04] disabled:opacity-50 sm:w-auto"
          style={{ color: MUTED }}
        >
          ยกเลิก
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-5 text-[14px] font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
          style={{ backgroundColor: INK, color: '#F5EEDA' }}
        >
          {submitting ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden />
              กำลังส่ง...
            </>
          ) : error?.retryable ? (
            'ลองอีกครั้ง'
          ) : (
            'ส่ง'
          )}
        </button>
      </div>

      {/* Focus ring is gold rather than the app's violet: this card is the
          warm AURUM surface the notification emails use, not the dark app
          chrome. Inline <style> keeps it next to the one element it styles
          instead of adding a global rule for a single widget. */}
      <style>{`
        .aurum-feedback__textarea::placeholder { color: ${MUTED}; }
        .aurum-feedback__textarea:focus {
          border-color: ${GOLD};
          box-shadow: 0 0 0 3px rgba(201, 169, 97, 0.18);
        }
      `}</style>
    </form>
  );
}
