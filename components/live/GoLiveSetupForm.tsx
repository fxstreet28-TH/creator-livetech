'use client';

/**
 * The right-hand column of /creator/live's setup state: what the live is
 * called, who may watch it, and at what quality.
 *
 * Same shape as PostMetadataForm — controlled value, validation exported
 * beside the fields, no submit button of its own — but not the same component:
 * a live has a quality choice and a cover URL that a post does not, and a post
 * has a `content` description that maps to a different column. What the two
 * genuinely share is the access-level control, so <VisibilityToggle> is reused
 * verbatim, including its CREATOR_PPV_ENABLED gate.
 *
 * That gate is right for live too, for a parallel reason: `mode: 'join'` in
 * live-create-session grants access for 'public' and checks a subscription for
 * 'subscribers', and has no branch at all for 'ppv' — every viewer of a PPV
 * live is refused, with no way to pay. A creator who picked PPV today would
 * broadcast to an audience that cannot be let in.
 */

import { useId } from 'react';
import { Radio } from 'lucide-react';
import { VisibilityToggle } from '@/components/creator/VisibilityToggle';
import type { CreatorVisibility } from '@/lib/creator/types';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_PPV_PRICE_STARS,
  MAX_TITLE_LENGTH,
  MIN_PPV_PRICE_STARS,
  MIN_TITLE_LENGTH,
  QUALITY_OPTIONS,
  isQualityAllowed,
} from '@/lib/live/constants';
import type { BroadcastQuality, LiveQuota } from '@/lib/live/types';

export interface GoLiveDraft {
  title: string;
  description: string;
  /** A URL, not a file: there is no image upload endpoint yet. */
  coverImageUrl: string;
  visibility: CreatorVisibility;
  /** Stars, as typed. Empty while blank. */
  ppvPrice: string;
  quality: BroadcastQuality;
}

export interface GoLiveErrors {
  title?: string;
  description?: string;
  coverImageUrl?: string;
  ppvPrice?: string;
}

export const EMPTY_DRAFT: GoLiveDraft = {
  title: '',
  description: '',
  coverImageUrl: '',
  // Public by default, unlike a post: an upload sits in a library where
  // "subscribers" is the safe default, whereas a live nobody can find is a
  // broadcast to an empty room for its whole duration.
  visibility: 'public',
  ppvPrice: '',
  quality: '720p',
};

/**
 * Client-side mirror of the backend's rules. `live-create-session` re-validates
 * (and clamps the quality to the tier cap), so this exists to teach the rule
 * before the round trip, not to enforce it.
 */
export function validateDraft(draft: GoLiveDraft): GoLiveErrors {
  const errors: GoLiveErrors = {};
  const title = draft.title.trim();

  if (title.length === 0) {
    errors.title = 'กรุณาตั้งชื่อไลฟ์';
  } else if (title.length < MIN_TITLE_LENGTH) {
    errors.title = `ชื่อไลฟ์ต้องมีอย่างน้อย ${MIN_TITLE_LENGTH} ตัวอักษร`;
  } else if (title.length > MAX_TITLE_LENGTH) {
    errors.title = `ชื่อไลฟ์ต้องไม่เกิน ${MAX_TITLE_LENGTH} ตัวอักษร`;
  }

  if (draft.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `คำอธิบายต้องไม่เกิน ${MAX_DESCRIPTION_LENGTH} ตัวอักษร`;
  }

  const cover = draft.coverImageUrl.trim();
  if (cover !== '' && !/^https:\/\/\S+$/i.test(cover)) {
    errors.coverImageUrl = 'ลิงก์ภาพต้องขึ้นต้นด้วย https://';
  }

  if (draft.visibility === 'ppv') {
    const price = draft.ppvPrice === '' ? NaN : Number(draft.ppvPrice);
    if (!Number.isInteger(price)) {
      errors.ppvPrice = 'กรุณากรอกราคาเป็นจำนวนเต็ม';
    } else if (price < MIN_PPV_PRICE_STARS || price > MAX_PPV_PRICE_STARS) {
      errors.ppvPrice = `ราคาต้องอยู่ระหว่าง ${MIN_PPV_PRICE_STARS}-${MAX_PPV_PRICE_STARS} ดาว`;
    }
  }

  return errors;
}

export function isDraftValid(draft: GoLiveDraft): boolean {
  return Object.keys(validateDraft(draft)).length === 0;
}

interface GoLiveSetupFormProps {
  value: GoLiveDraft;
  onChange: (value: GoLiveDraft) => void;
  errors?: GoLiveErrors;
  /** Null while the tier lookup is in flight or failed. */
  quota: LiveQuota | null;
  quotaLoading: boolean;
  /** Thai, renderable. The reason the creator cannot go live at all. */
  blockedReason?: string | null;
  disabled?: boolean;
  submitting?: boolean;
  /** True once the camera is publishing a track. */
  cameraReady?: boolean;
  /** Thai, renderable. The last go-live failure. */
  submitError?: string | null;
}

const INPUT_CLASS =
  'w-full min-w-0 rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-base text-white placeholder:text-white/25 focus:border-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400';

export function GoLiveSetupForm({
  value,
  onChange,
  errors = {},
  quota,
  quotaLoading,
  blockedReason,
  disabled = false,
  submitting = false,
  cameraReady = false,
  submitError,
}: GoLiveSetupFormProps) {
  const titleId = useId();
  const titleErrorId = useId();
  const descriptionId = useId();
  const descriptionErrorId = useId();
  const coverId = useId();
  const coverErrorId = useId();
  const qualityId = useId();

  const set = <K extends keyof GoLiveDraft>(key: K, next: GoLiveDraft[K]) =>
    onChange({ ...value, [key]: next });

  const blocked = blockedReason != null;
  const canSubmit = !disabled && !submitting && !blocked && cameraReady;

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={titleId} className="text-sm font-medium text-white/75">
            ชื่อไลฟ์ <span className="text-rose-300">*</span>
          </label>
          <span className="text-[11px] tabular-nums text-white/35">
            {value.title.length}/{MAX_TITLE_LENGTH}
          </span>
        </div>
        <input
          id={titleId}
          type="text"
          maxLength={MAX_TITLE_LENGTH}
          value={value.title}
          disabled={disabled}
          onChange={(event) => set('title', event.target.value)}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? titleErrorId : undefined}
          placeholder="เช่น คุยสดวันศุกร์ EP.1"
          className={`mt-2 ${INPUT_CLASS}`}
        />
        {errors.title && (
          <p id={titleErrorId} role="alert" className="mt-2 text-xs text-rose-300">
            {errors.title}
          </p>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={descriptionId} className="text-sm font-medium text-white/75">
            คำอธิบาย
          </label>
          <span className="text-[11px] tabular-nums text-white/35">
            {value.description.length}/{MAX_DESCRIPTION_LENGTH}
          </span>
        </div>
        <textarea
          id={descriptionId}
          rows={3}
          maxLength={MAX_DESCRIPTION_LENGTH}
          value={value.description}
          disabled={disabled}
          onChange={(event) => set('description', event.target.value)}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? descriptionErrorId : undefined}
          placeholder="วันนี้จะไลฟ์เรื่องอะไร (ไม่บังคับ)"
          className={`mt-2 resize-y ${INPUT_CLASS}`}
        />
        {errors.description && (
          <p id={descriptionErrorId} role="alert" className="mt-2 text-xs text-rose-300">
            {errors.description}
          </p>
        )}
      </div>

      <VisibilityToggle
        value={value.visibility}
        onChange={(next) => set('visibility', next)}
        ppvPrice={value.ppvPrice}
        onPpvPriceChange={(next) => set('ppvPrice', next)}
        ppvError={errors.ppvPrice ?? null}
        disabled={disabled}
      />

      <div className="min-w-0">
        <label htmlFor={qualityId} className="block text-sm font-medium text-white/75">
          คุณภาพการถ่ายทอด
        </label>
        <select
          id={qualityId}
          value={value.quality}
          disabled={disabled || quotaLoading}
          onChange={(event) => set('quality', event.target.value as BroadcastQuality)}
          className={`mt-2 h-12 ${INPUT_CLASS} py-0`}
        >
          {QUALITY_OPTIONS.map((option) => {
            // Options above the tier cap stay in the list, disabled, with the
            // tier that would unlock them — the same reasoning as the PPV
            // option in VisibilityToggle. Hiding them would leave a creator
            // wondering why their dropdown is shorter than the pricing page.
            // The backend clamps to the cap regardless of what is sent.
            const allowed = quota ? isQualityAllowed(option.value, quota.maxQuality) : true;
            return (
              <option key={option.value} value={option.value} disabled={!allowed}>
                {option.label}
                {allowed ? '' : ` — ต้องใช้แพ็กเกจ ${option.minTierLabel}`}
              </option>
            );
          })}
        </select>
      </div>

      <div className="min-w-0">
        <label htmlFor={coverId} className="block text-sm font-medium text-white/75">
          ลิงก์ภาพหน้าปก
        </label>
        <input
          id={coverId}
          type="url"
          inputMode="url"
          value={value.coverImageUrl}
          disabled={disabled}
          onChange={(event) => set('coverImageUrl', event.target.value)}
          aria-invalid={errors.coverImageUrl ? true : undefined}
          aria-describedby={errors.coverImageUrl ? coverErrorId : undefined}
          placeholder="https://... (ไม่บังคับ)"
          className={`mt-2 ${INPUT_CLASS}`}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          {/* No file input: there is no image upload endpoint yet, and a
              dropzone that can only fail is worse than an honest URL field.
              TODO(post-launch): upload covers once storage is wired. */}
          ใช้เป็นภาพหน้าปกในหน้าค้นพบ ถ้าไม่ใส่จะใช้พื้นหลังไล่สีแทน
        </p>
        {errors.coverImageUrl && (
          <p id={coverErrorId} role="alert" className="mt-2 text-xs text-rose-300">
            {errors.coverImageUrl}
          </p>
        )}
      </div>

      <QuotaNotice quota={quota} loading={quotaLoading} blockedReason={blockedReason} />

      {submitError && (
        <p
          role="alert"
          className="rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm leading-relaxed text-rose-100"
        >
          {submitError}
        </p>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex min-h-[3.25rem] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-rose-500 to-pink-500 px-5 py-4 text-base font-extrabold text-white transition hover:shadow-lg hover:shadow-rose-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none"
      >
        <Radio size={18} aria-hidden />
        {submitting ? 'กำลังเริ่มไลฟ์...' : '🔴 ไลฟ์สด'}
      </button>

      {!cameraReady && !blocked && (
        <p className="-mt-2 text-center text-xs text-white/40">
          รอให้กล้องพร้อมก่อนจึงจะเริ่มไลฟ์ได้
        </p>
      )}
    </div>
  );
}

/** "เหลือเวลาวันนี้" and the concurrent-viewer ceiling, straight from the tier. */
function QuotaNotice({
  quota,
  loading,
  blockedReason,
}: {
  quota: LiveQuota | null;
  loading: boolean;
  blockedReason?: string | null;
}) {
  if (loading) {
    return <div aria-hidden className="h-16 animate-pulse rounded-2xl border border-white/10 bg-white/5" />;
  }

  if (blockedReason) {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm leading-relaxed text-amber-100"
      >
        {blockedReason}
      </div>
    );
  }

  // A failed quota read is not an error state: live-create-session runs the
  // same check and refuses in Thai if it has to. Saying nothing beats saying
  // something wrong about someone's plan.
  if (!quota) return null;

  return (
    <dl className="grid grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-center">
      <div>
        <dt className="text-[11px] text-white/45">เหลือเวลาวันนี้</dt>
        <dd className="mt-1 text-base font-bold tabular-nums text-white">
          {quota.hoursRemainingToday.toFixed(1)} ชั่วโมง
        </dd>
      </div>
      <div>
        <dt className="text-[11px] text-white/45">จำนวนผู้ชมสูงสุด</dt>
        <dd className="mt-1 text-base font-bold tabular-nums text-white">
          {quota.maxViewers.toLocaleString('th-TH')} คน
        </dd>
      </div>
    </dl>
  );
}
