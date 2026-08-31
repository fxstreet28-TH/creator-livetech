'use client';

/**
 * "เลือกลุค" — the six camera looks, as a segmented chip group.
 *
 * Same chip shape as the access-level picker on the upload and go-live forms
 * (components/creator/VisibilityToggle), because it is the same kind of choice
 * and a creator should not have to learn a second control.
 *
 * The notice under the chips is not optional decoration. A CSS filter styles
 * the element that paints the camera track, not the track itself, so viewers
 * see the raw feed — a creator who picks "วินเทจ" and is never told that will
 * find out from a comment. See lib/live/cameraFilters.ts for what broadcasting
 * the look would actually take.
 */

import { useId } from 'react';
import { Info } from 'lucide-react';
import {
  CAMERA_FILTERS,
  FILTER_ORDER,
  LOCAL_ONLY_NOTICE,
  type FilterId,
} from '@/lib/live/cameraFilters';

interface CameraFilterSelectorProps {
  value: FilterId;
  onChange: (id: FilterId) => void;
  disabled?: boolean;
  className?: string;
}

export function CameraFilterSelector({
  value,
  onChange,
  disabled = false,
  className = '',
}: CameraFilterSelectorProps) {
  const noticeId = useId();

  return (
    <fieldset disabled={disabled} className={`min-w-0 ${className}`}>
      <legend className="mb-2 text-sm font-medium text-white/75">เลือกลุค</legend>

      <div className="flex flex-wrap gap-2">
        {FILTER_ORDER.map((id) => {
          const selected = value === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              aria-describedby={noticeId}
              onClick={() => onChange(id)}
              className={[
                'inline-flex min-h-11 items-center rounded-xl border px-3.5 text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
                selected
                  ? 'border-transparent bg-gradient-to-br from-purple-500/25 to-cyan-500/20 text-white shadow-[0_0_0_1px_rgba(139,92,246,0.55)]'
                  : 'border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/[0.06]',
              ].join(' ')}
            >
              {CAMERA_FILTERS[id].label}
            </button>
          );
        })}
      </div>

      <p id={noticeId} className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-white/40">
        <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
        <span>{LOCAL_ONLY_NOTICE}</span>
      </p>
    </fieldset>
  );
}
