'use client';

/**
 * Title, description and access level — the fields that describe a post.
 *
 * Deliberately renders no submit button: the upload screen puts one at the
 * bottom of a sticky mobile bar and PostEditModal puts a save/cancel pair in a
 * dialog footer, so the caller supplies its own actions via `footer` and this
 * component stays the single definition of the fields and their rules.
 */

import { useId } from 'react';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_PPV_PRICE_STARS,
  MAX_TITLE_LENGTH,
  MIN_PPV_PRICE_STARS,
  MIN_TITLE_LENGTH,
} from '@/lib/creator/constants';
import type { CreatorVisibility } from '@/lib/creator/types';
import { VisibilityToggle } from './VisibilityToggle';

export interface PostMetadata {
  title: string;
  description: string;
  visibility: CreatorVisibility;
  /** Stars, as typed. Empty while blank. */
  ppvPrice: string;
}

export interface PostMetadataErrors {
  title?: string;
  description?: string;
  ppvPrice?: string;
}

export const EMPTY_METADATA: PostMetadata = {
  title: '',
  description: '',
  // Subscribers-first: the same default the backend uses when access_level is
  // omitted, and the conservative one — a creator who does not think about it
  // has not accidentally made their content public.
  visibility: 'subscribers',
  ppvPrice: '',
};

/**
 * Client-side mirror of what the backend and the CHECK constraints allow.
 * The backend re-validates everything; this exists so the creator learns the
 * rule before the round trip, not after it.
 */
export function validateMetadata(metadata: PostMetadata): PostMetadataErrors {
  const errors: PostMetadataErrors = {};
  const title = metadata.title.trim();

  if (title.length === 0) {
    errors.title = 'กรุณาตั้งชื่อวิดีโอ';
  } else if (title.length < MIN_TITLE_LENGTH) {
    errors.title = `ชื่อวิดีโอต้องมีอย่างน้อย ${MIN_TITLE_LENGTH} ตัวอักษร`;
  } else if (title.length > MAX_TITLE_LENGTH) {
    errors.title = `ชื่อวิดีโอต้องไม่เกิน ${MAX_TITLE_LENGTH} ตัวอักษร`;
  }

  if (metadata.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `คำอธิบายต้องไม่เกิน ${MAX_DESCRIPTION_LENGTH} ตัวอักษร`;
  }

  if (metadata.visibility === 'ppv') {
    const price = metadata.ppvPrice === '' ? NaN : Number(metadata.ppvPrice);
    if (!Number.isInteger(price)) {
      errors.ppvPrice = 'กรุณากรอกราคาเป็นจำนวนเต็ม';
    } else if (price < MIN_PPV_PRICE_STARS || price > MAX_PPV_PRICE_STARS) {
      errors.ppvPrice = `ราคาต้องอยู่ระหว่าง ${MIN_PPV_PRICE_STARS}-${MAX_PPV_PRICE_STARS} ดาว`;
    }
  }

  return errors;
}

export function isMetadataValid(metadata: PostMetadata): boolean {
  return Object.keys(validateMetadata(metadata)).length === 0;
}

interface PostMetadataFormProps {
  value: PostMetadata;
  onChange: (value: PostMetadata) => void;
  /** Errors are only rendered once the caller decides to show them. */
  errors?: PostMetadataErrors;
  disabled?: boolean;
  footer?: React.ReactNode;
}

const INPUT_CLASS =
  'w-full min-w-0 rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-base text-white placeholder:text-white/25 focus:border-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400';

export function PostMetadataForm({
  value,
  onChange,
  errors = {},
  disabled = false,
  footer,
}: PostMetadataFormProps) {
  const titleId = useId();
  const titleErrorId = useId();
  const descriptionId = useId();
  const descriptionErrorId = useId();

  const set = <K extends keyof PostMetadata>(key: K, next: PostMetadata[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={titleId} className="text-sm font-medium text-white/75">
            ชื่อวิดีโอ <span className="text-rose-300">*</span>
          </label>
          <span className="text-[11px] tabular-nums text-white/35">
            {value.title.length}/{MAX_TITLE_LENGTH}
          </span>
        </div>
        <input
          id={titleId}
          type="text"
          // maxLength rather than a validation error for the ceiling: the
          // counter already shows the limit, and silently refusing the 81st
          // character is less annoying than an error appearing under the field.
          maxLength={MAX_TITLE_LENGTH}
          value={value.title}
          disabled={disabled}
          onChange={(event) => set('title', event.target.value)}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? titleErrorId : undefined}
          placeholder="เช่น เบื้องหลังการถ่ายทำ EP.1"
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
          rows={4}
          maxLength={MAX_DESCRIPTION_LENGTH}
          value={value.description}
          disabled={disabled}
          onChange={(event) => set('description', event.target.value)}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? descriptionErrorId : undefined}
          placeholder="เล่าให้ผู้ชมฟังว่าวิดีโอนี้เกี่ยวกับอะไร (ไม่บังคับ)"
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

      {footer}
    </div>
  );
}
