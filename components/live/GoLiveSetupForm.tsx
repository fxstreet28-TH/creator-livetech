'use client';

/**
 * The right-hand column of /creator/live's setup state: what the live is
 * called, who may watch it, at what quality, and how close to real time.
 *
 * Same shape as PostMetadataForm — controlled value, validation exported
 * beside the fields, no submit button of its own — but not the same component:
 * a live has a quality choice and a cover URL that a post does not, and a post
 * has a `content` description that maps to a different column. What the two
 * genuinely share is the access-level control, so <VisibilityToggle> is reused
 * verbatim, including its CREATOR_PPV_ENABLED gate.
 *
 * That gate is right for live too, for a parallel reason: `can_watch_live_session`
 * grants access for 'public' and checks a subscription for 'subscribers', and
 * returns false for 'ppv' — every viewer of a PPV live is refused, with no way
 * to pay. A creator who picked PPV today would broadcast to an audience that
 * cannot be let in.
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
  LATENCY_LABELS,
  QUALITY_OPTIONS,
  isQualityAllowed,
} from '@/lib/live/constants';
import type { BroadcastQuality, LatencyMode, LiveQuota } from '@/lib/live/types';

export interface GoLiveDraft {
  title: string;
  description: string;
  /** A URL, not a file: there is no image upload endpoint yet. */
  coverImageUrl: string;
  visibility: CreatorVisibility;
  /** Stars, as typed. Empty while blank. */
  ppvPrice: string;
  quality: BroadcastQuality;
  latency: LatencyMode;
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
  // 3-5s: the latency the product promises, and the figure the cost model is
  // built on. 'standard' is the dial to reach for when a stream stutters —
  // exposed here so that is a choice a creator can make rather than a deploy.
  latency: 'low_latency',
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
  /**
   * Where the go-live button sits.
   *
   * 'inline' is the desktop card: the button is the last thing in a column the
   * page scrolls. 'sticky' is the phone form, where the fields are longer than
   * the screen and a button at the end of them is a button the creator has to
   * go looking for — so it rides the bottom of the viewport instead, with the
   * submit error and the camera hint stacked above it.
   *
   * The two share `canSubmit`, the quota gate and every message. Only the box
   * they are drawn in differs; a second copy of that logic is exactly how a
   * phone ends up able to press a button the desktop would have refused.
   */
  submitPlacement?: 'inline' | 'sticky';
  /**
   * Whether this is the desktop studio. Decides if 1080p is on offer.
   *
   * Passed rather than measured here: the page has already resolved the media
   * query to choose between two whole layouts (see useIsMobileViewport), and a
   * second `matchMedia` in this component could disagree with it for a frame
   * and offer a rung the studio around it cannot serve.
   */
  desktop?: boolean;
  /**
   * True when the rung on the dropdown was restored from the last broadcast
   * rather than chosen here. Renders one line saying so.
   *
   * IT IS NOT COSMETIC. The rung is the billing line (see
   * bunnyThbPerViewerMinute), and a bill that moved because a browser
   * remembered something is a bill nobody agreed to — so the restore is
   * visible, in the same glance as the value it explains, before anything is
   * created. See lib/live/studioQuality.
   */
  qualityRestored?: boolean;
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
  submitPlacement = 'inline',
  desktop = true,
  qualityRestored = false,
}: GoLiveSetupFormProps) {
  const titleId = useId();
  const titleErrorId = useId();
  const descriptionId = useId();
  const descriptionErrorId = useId();
  const coverId = useId();
  const coverErrorId = useId();
  const qualityId = useId();

  /**
   * Should the form suggest 1080p? See the note beside where it renders.
   *
   * `quotaLoading` is part of the condition rather than a wrapper around it: a
   * nudge that appears, then vanishes when the quota says the tier cannot
   * reach 1080p, is a worse experience than one that arrives a moment late.
   */
  const nudgeTo1080 =
    desktop &&
    !quotaLoading &&
    value.quality !== '1080p' &&
    quota !== null &&
    isQualityAllowed('1080p', quota.maxQuality);
  const latencyId = useId();

  const set = <K extends keyof GoLiveDraft>(key: K, next: GoLiveDraft[K]) =>
    onChange({ ...value, [key]: next });

  const blocked = blockedReason != null;
  const canSubmit = !disabled && !submitting && !blocked && cameraReady;
  const sticky = submitPlacement === 'sticky';

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
          {QUALITY_OPTIONS.filter(
            // 1080p is a desktop rung — see `desktopOnly` on the option. Kept
            // in the list where it is the value already chosen, which a
            // creator can reach by shrinking a desktop window past the
            // breakpoint: dropping the option out from under a live selection
            // would leave the select rendering blank while still holding
            // '1080p', and the studio would publish a rung the form denies.
            (option) => !option.desktopOnly || desktop || option.value === value.quality,
          ).map((option) => {
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

        {/*
          WHERE THIS VALUE CAME FROM, when it was not chosen here.

          One line, and only when a rung was actually restored. See
          `qualityRestored` — the point is that a creator never discovers from
          an invoice that their browser made a billing decision for them.
        */}
        {qualityRestored && (
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            จำค่าจากไลฟ์ครั้งก่อน — เปลี่ยนได้จากรายการด้านบน
          </p>
        )}

        {/*
          THE 1080p NUDGE, and why it is here rather than mid-broadcast.

          A rung is fixed when the session row is created: `broadcast_quality`
          is written once, the canvas size and the encoder ceiling both derive
          from it, and changing it later would mean tearing down the publish
          and rebuilding it — which under HLS breaks the playlist every viewer
          is mid-segment on. So the only honest moment to ask "are you about to
          share a chart?" is BEFORE going live, which is this form.

          Offered when all three hold: this is a desktop (where a share is even
          possible — getDisplayMedia does not exist on iOS), the creator's tier
          reaches 1080p, and they are currently on something lower. One tap
          takes it, and it is a suggestion in a form rather than a change made
          on their behalf — the rung is the bill.
        */}
        {nudgeTo1080 && (
          <p className="mt-2 text-[11px] leading-relaxed text-cyan-200/70">
            แชร์กราฟบนเดสก์ท็อป? 1080p ทำให้เส้นเทียนและราคาบนแกนอ่านออกบนมือถือ{' '}
            <button
              type="button"
              onClick={() => set('quality', '1080p')}
              disabled={disabled}
              className="font-semibold text-cyan-200 underline underline-offset-2 hover:text-cyan-100 disabled:opacity-40"
            >
              เปลี่ยนเป็น 1080p
            </button>
          </p>
        )}
      </div>

      <div className="min-w-0">
        <label htmlFor={latencyId} className="block text-sm font-medium text-white/75">
          ความหน่วงของภาพ
        </label>
        <select
          id={latencyId}
          value={value.latency}
          disabled={disabled}
          onChange={(event) => set('latency', event.target.value as LatencyMode)}
          className={`mt-2 h-12 ${INPUT_CLASS} py-0`}
        >
          {/* Every option is available to every tier: this is how much buffer
              the VIEWER's player keeps, not how much bandwidth the platform
              pays for, so there is nothing to gate. */}
          {(['ultra_low', 'low_latency', 'standard'] as LatencyMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {LATENCY_LABELS[mode]}
            </option>
          ))}
        </select>
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          ยิ่งหน่วงน้อย ยิ่งคุยกับผู้ชมได้ทันที แต่ภาพอาจสะดุดง่ายกว่าเมื่อเน็ตไม่นิ่ง
        </p>
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

      <div
        className={
          sticky
            ? // Rides the bottom of the phone viewport, clear of the home
              // indicator, with the page's own ground behind it so the fields
              // scrolling underneath do not read through it.
              'sticky bottom-0 -mx-4 mt-1 flex flex-col gap-3 border-t border-white/10 bg-[#0a0a15]/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl'
            : // `contents` rather than a flex column: the three children stay
              // DIRECT children of the form's own `gap-5` stack, so the desktop
              // card renders exactly as it did before this wrapper existed.
              'contents'
        }
      >
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
          <p className={`text-center text-xs text-white/40 ${sticky ? '' : '-mt-2'}`}>
            รอให้กล้องพร้อมก่อนจึงจะเริ่มไลฟ์ได้
          </p>
        )}
      </div>
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
