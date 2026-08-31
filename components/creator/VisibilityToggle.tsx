'use client';

/**
 * Who can watch this post — a three-option segmented control writing
 * `feed_posts.access_level`.
 *
 * PPV is rendered but not selectable while CREATOR_PPV_ENABLED is off. It is
 * shown rather than hidden, unlike the wallet's Buyback button, because the
 * two absences mean different things: buyback is reachable another way (via
 * support), whereas PPV is simply not built yet on the backend, and a creator
 * deciding how to price their content deserves to know it is coming. The
 * control stays in the tab order with aria-disabled + aria-describedby, so a
 * screen-reader user hears both that it is unavailable and why — the pattern
 * app/wallet/page.tsx established.
 */

import { useId } from 'react';
import {
  MAX_PPV_PRICE_STARS,
  MIN_PPV_PRICE_STARS,
  PPV_THB_PER_STAR,
  VISIBILITY_OPTIONS,
} from '@/lib/creator/constants';
import type { CreatorVisibility } from '@/lib/creator/types';
import { CREATOR_PPV_ENABLED } from '@/lib/features';
import { formatStars, formatThbWithUnit } from '@/lib/wallet/format';
import { PrismStar } from '@/components/star/PrismStar';

interface VisibilityToggleProps {
  value: CreatorVisibility;
  onChange: (value: CreatorVisibility) => void;
  /** Stars. Empty string while the field is blank. */
  ppvPrice: string;
  onPpvPriceChange: (value: string) => void;
  /** Rendered under the price input once the user has tried to submit. */
  ppvError?: string | null;
  disabled?: boolean;
}

export function VisibilityToggle({
  value,
  onChange,
  ppvPrice,
  onPpvPriceChange,
  ppvError,
  disabled = false,
}: VisibilityToggleProps) {
  const priceId = useId();
  const ppvHintId = useId();
  const priceErrorId = useId();

  const priceStars = ppvPrice === '' ? 0 : Number(ppvPrice);
  const priceIsNumber = Number.isFinite(priceStars) && priceStars > 0;

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-2 text-sm font-medium text-white/75">การเข้าถึง</legend>

      <div className="grid gap-2 sm:grid-cols-3">
        {VISIBILITY_OPTIONS.map((option) => {
          const isPpv = option.value === 'ppv';
          const unavailable = isPpv && !CREATOR_PPV_ENABLED;
          const selected = value === option.value;

          return (
            <button
              key={option.value}
              type="button"
              // aria-disabled rather than `disabled`: a disabled button leaves
              // the tab order entirely, taking its explanation with it.
              aria-disabled={unavailable || undefined}
              aria-pressed={selected}
              aria-describedby={unavailable ? ppvHintId : undefined}
              onClick={() => {
                if (unavailable) return;
                onChange(option.value);
              }}
              className={[
                'flex min-h-[4.25rem] flex-col items-center justify-center gap-0.5 rounded-2xl border px-3 py-3 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
                unavailable
                  ? 'cursor-not-allowed border-white/8 bg-white/[0.02] text-white/30'
                  : selected
                    ? 'border-transparent bg-gradient-to-br from-purple-500/25 to-cyan-500/20 text-white shadow-[0_0_0_1px_rgba(139,92,246,0.55)]'
                    : 'border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/[0.06]',
              ].join(' ')}
            >
              <span className="text-lg leading-none" aria-hidden>
                {option.emoji}
              </span>
              <span className="text-[13px] font-semibold leading-tight">{option.label}</span>
              <span className="text-[11px] leading-tight text-white/45">
                {unavailable ? 'ยังไม่เปิดให้ใช้งาน' : option.hint}
              </span>
            </button>
          );
        })}
      </div>

      {!CREATOR_PPV_ENABLED && (
        <p id={ppvHintId} className="mt-2 text-[11px] leading-relaxed text-white/35">
          การขายแบบปลดล็อกด้วย Stars (PPV) กำลังพัฒนา — เร็ว ๆ นี้
        </p>
      )}

      {CREATOR_PPV_ENABLED && value === 'ppv' && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
          <label htmlFor={priceId} className="block text-sm font-medium text-white/75">
            ราคาปลดล็อก
          </label>

          <div className="mt-2 flex items-center gap-3">
            {/* TODO: swap to the Variant C Deluxe star when that PR integrates;
                PrismStar is the shipped aurora star today (PR #30-#32). */}
            <PrismStar size={30} showChargeEffects={false} aria-label="Stars" />
            <input
              id={priceId}
              type="number"
              inputMode="numeric"
              min={MIN_PPV_PRICE_STARS}
              max={MAX_PPV_PRICE_STARS}
              step={1}
              value={ppvPrice}
              onChange={(event) => onPpvPriceChange(event.target.value)}
              aria-invalid={ppvError ? true : undefined}
              aria-describedby={ppvError ? priceErrorId : undefined}
              placeholder={`${MIN_PPV_PRICE_STARS}-${MAX_PPV_PRICE_STARS}`}
              className="h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black/30 px-3 text-base text-white placeholder:text-white/25 focus:border-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            />
            <span className="shrink-0 text-sm text-white/50">Stars</span>
          </div>

          <p className="mt-2 text-xs text-white/45">
            {priceIsNumber
              ? `ผู้ชมจ่าย ${formatStars(priceStars)} ดาว (≈ ${formatThbWithUnit(priceStars * PPV_THB_PER_STAR)})`
              : `ตั้งได้ ${MIN_PPV_PRICE_STARS}-${MAX_PPV_PRICE_STARS} ดาว`}
          </p>

          {ppvError && (
            <p id={priceErrorId} role="alert" className="mt-2 text-xs text-rose-300">
              {ppvError}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
