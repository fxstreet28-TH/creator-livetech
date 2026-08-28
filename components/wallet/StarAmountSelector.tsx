'use client';

/**
 * How many stars to buy: six preset tiles, or a slider and a number input for
 * anything else.
 *
 * Presentational. It owns the text field's in-progress string (so a user can
 * clear the box and retype without the value snapping back under them) and
 * nothing else — the committed amount, its validity and the purchase itself
 * all live in BuyStarsForm.
 */

import { useId, useState } from 'react';
import {
  MAX_PURCHASE_STARS,
  MIN_PURCHASE_STARS,
  SLIDER_STOPS,
  STAR_PRESETS,
  nearestStopIndex,
} from '@/lib/constants/stars';
import { formatStars, formatThbWithUnit } from '@/lib/wallet/format';

export type AmountSource = 'preset' | 'custom';

interface StarAmountSelectorProps {
  /** Committed star amount. May be out of range while the user types. */
  value: number;
  onChange: (stars: number, source: AmountSource) => void;
  /** THB per star, already resolved from wallet-pricing. */
  retailThbPerStar: number;
  /** Thai validation message to render under the input, or null. */
  validationError: string | null;
  disabled?: boolean;
}

export function StarAmountSelector({
  value,
  onChange,
  retailThbPerStar,
  validationError,
  disabled = false,
}: StarAmountSelectorProps) {
  const inputId = useId();
  const sliderId = useId();
  const errorId = useId();

  // The text field is a string, not a number: "" and "1" are states a user
  // passes through on the way to "100", and coercing them to a number on
  // every keystroke would rewrite the box while they are still typing.
  const [inputText, setInputText] = useState(String(value));

  // Re-sync when the amount changes from somewhere else — a preset tile, the
  // slider, or the form resetting after a purchase.
  //
  // Adjusted during render rather than in an effect. React re-runs this
  // component immediately with the new state and before touching the DOM, so
  // the box never paints the stale amount; an effect would paint it once and
  // then correct it, and would also be a cascading-render lint error. This is
  // the documented "adjusting state when a prop changes" pattern.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    // Guarded on the parsed value so "0050" is not rewritten to "50"
    // underneath someone who is still typing.
    if (Number(inputText) !== value) setInputText(String(value));
  }

  const sliderIndex = nearestStopIndex(value);

  function commit(stars: number, source: AmountSource) {
    onChange(stars, source);
  }

  function handleText(raw: string) {
    // Digits only. Rejecting the keystroke rather than sanitising after the
    // fact keeps the caret where the user left it.
    const digits = raw.replace(/\D/g, '');
    setInputText(digits);
    if (digits === '') {
      // Report an out-of-range zero rather than silently holding the last
      // valid amount: the submit button must disable while the box is empty.
      commit(0, 'custom');
      return;
    }
    commit(Number(digits), 'custom');
  }

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="min-w-0" disabled={disabled}>
        <legend className="mb-3 text-sm font-medium text-white/70">เลือกจำนวน Stars</legend>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {STAR_PRESETS.map((preset) => {
            const selected = value === preset.stars;
            return (
              <button
                key={preset.stars}
                type="button"
                onClick={() => commit(preset.stars, 'preset')}
                aria-pressed={selected}
                aria-label={`${formatStars(preset.stars)} Stars ราคา ${formatThbWithUnit(
                  preset.stars * retailThbPerStar,
                )}`}
                className={`flex min-h-[5.5rem] flex-col items-center justify-center gap-1 rounded-2xl border px-3 py-4 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50 ${
                  selected
                    ? 'border-purple-400/70 bg-gradient-to-br from-purple-600/30 to-pink-600/20 shadow-lg shadow-purple-500/20'
                    : preset.highlighted
                      ? 'border-purple-500/40 bg-white/[0.04] hover:border-purple-400/60 hover:bg-white/[0.07]'
                      : 'border-white/8 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]'
                }`}
              >
                {preset.badge && (
                  <span
                    className={`text-[10px] font-semibold tracking-wide ${
                      preset.highlighted ? 'text-pink-300' : 'text-white/45'
                    }`}
                  >
                    {preset.badge}
                  </span>
                )}
                <span className="text-lg font-bold text-white">
                  {formatStars(preset.stars)}
                  <span className="ml-1 text-xs font-medium text-white/50">Stars</span>
                </span>
                <span className="text-xs text-white/60">
                  {formatThbWithUnit(preset.stars * retailThbPerStar)}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
        <label htmlFor={sliderId} className="text-sm font-medium text-white/70">
          หรือกำหนดจำนวนเอง
        </label>

        <input
          id={sliderId}
          type="range"
          min={0}
          max={SLIDER_STOPS.length - 1}
          step={1}
          value={sliderIndex}
          disabled={disabled}
          onChange={(event) => commit(SLIDER_STOPS[Number(event.target.value)], 'custom')}
          // The slider's own value is an index into SLIDER_STOPS, which is
          // meaningless read aloud. valuetext replaces "32" with the star
          // count and price a screen reader user actually needs.
          aria-valuetext={`${formatStars(SLIDER_STOPS[sliderIndex])} Stars ${formatThbWithUnit(
            SLIDER_STOPS[sliderIndex] * retailThbPerStar,
          )}`}
          className="mt-4 h-11 w-full cursor-pointer accent-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
        />

        <div className="flex justify-between text-[11px] text-white/40">
          <span>{formatStars(MIN_PURCHASE_STARS)}</span>
          <span>{formatStars(MAX_PURCHASE_STARS)}</span>
        </div>

        <div className="mt-4">
          <label htmlFor={inputId} className="mb-2 block text-sm font-medium text-white/70">
            จำนวน Stars
          </label>
          <div className="flex items-center gap-3">
            <input
              id={inputId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={inputText}
              disabled={disabled}
              onChange={(event) => handleText(event.target.value)}
              aria-describedby={validationError ? errorId : undefined}
              aria-invalid={validationError ? true : undefined}
              className={`min-h-11 w-full rounded-xl border bg-[#0a0a12] px-4 py-3 text-base text-white transition placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50 ${
                validationError ? 'border-red-500/60' : 'border-white/10 focus:border-purple-400'
              }`}
              placeholder={String(MIN_PURCHASE_STARS)}
            />
            <span className="shrink-0 text-sm text-white/50">Stars</span>
          </div>

          {validationError && (
            <p id={errorId} role="alert" className="mt-2 text-sm text-red-300">
              {validationError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
