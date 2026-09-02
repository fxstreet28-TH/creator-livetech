'use client';

/**
 * "กล้อง" — the two orientation switches, as a small settings panel.
 *
 * Sits next to "เลือกลุค" and looks like it on purpose: same panel chrome,
 * same 44px touch targets, same focus ring. A creator should read this as the
 * second half of one camera menu, not as a different control someone else
 * built.
 *
 * There is no shadcn Switch in this project — no components/ui at all — so
 * the switch here is a plain <button role="switch">, which is the accessible
 * primitive shadcn's own Switch wraps. `aria-checked` carries the state and
 * the label element is the button's accessible name.
 *
 * The copy under each switch is doing real work: these two toggles are the
 * only place in the app where "what I see" and "what they see" can disagree,
 * and a creator who cannot tell which one they just changed will flip the
 * wrong one on air. See lib/live/cameraOrientation.ts for how the two stay
 * independent.
 */

import { useId } from 'react';
import { Monitor, Users } from 'lucide-react';
import type { CameraOrientation } from '@/lib/live/cameraOrientation';

interface CameraControlsMenuProps {
  value: CameraOrientation;
  onChange: (next: CameraOrientation) => void;
  disabled?: boolean;
  className?: string;
}

export function CameraControlsMenu({
  value,
  onChange,
  disabled = false,
  className = '',
}: CameraControlsMenuProps) {
  return (
    <fieldset disabled={disabled} className={`min-w-0 ${className}`}>
      <legend className="mb-2 text-sm font-medium text-white/75">กล้อง</legend>

      <div className="grid gap-1">
        <OrientationSwitch
          checked={value.mirrorPreview}
          onChange={(mirrorPreview) => onChange({ ...value, mirrorPreview })}
          icon={<Monitor size={14} aria-hidden />}
          label="กลับกระจกภาพตัวเอง"
          hint={
            value.mirrorPreview
              ? 'เห็นเหมือนส่องกระจก — ยกมือขวาจะอยู่ทางซ้ายของจอ'
              : 'เห็นตรงตามจริง — ยกมือขวาจะอยู่ทางขวาของจอ'
          }
          note="มีผลกับจอของคุณเท่านั้น ผู้ชมไม่เห็นการเปลี่ยนแปลงนี้"
        />

        <OrientationSwitch
          checked={value.flipOutput}
          onChange={(flipOutput) => onChange({ ...value, flipOutput })}
          icon={<Users size={14} aria-hidden />}
          label="กลับด้านภาพสำหรับผู้ชม"
          hint={
            value.flipOutput
              ? 'ผู้ชมเห็นภาพกลับด้านซ้าย-ขวา'
              : 'ผู้ชมเห็นภาพตามปกติ'
          }
          note="เหมาะกับกรณีมีตัวหนังสือหรือกราฟิกอยู่ด้านหลัง จะได้อ่านออก"
        />
      </div>
    </fieldset>
  );
}

function OrientationSwitch({
  checked,
  onChange,
  icon,
  label,
  hint,
  note,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
  note: string;
}) {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <div className="rounded-xl px-1 py-2">
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-white/40">{icon}</span>
          <span id={labelId} className="text-[13px] font-semibold text-white/85">
            {label}
          </span>
        </span>

        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          onClick={() => onChange(!checked)}
          className={[
            // h-11 on the hit area, not on the track: the track is the 44px
            // target's visible middle, which keeps the row compact without
            // making it a thumb-sized miss on a phone.
            'group relative inline-flex h-11 w-12 shrink-0 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
          ].join(' ')}
        >
          <span
            aria-hidden
            className={[
              'block h-6 w-11 rounded-full border transition-colors',
              checked
                ? 'border-transparent bg-gradient-to-r from-purple-500/70 to-cyan-500/60'
                : 'border-white/12 bg-white/10 group-hover:bg-white/15',
            ].join(' ')}
          >
            <span
              className={[
                'mt-[3px] block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform',
                checked ? 'translate-x-[23px]' : 'translate-x-[3px]',
              ].join(' ')}
            />
          </span>
        </button>
      </div>

      <p id={descriptionId} className="mt-1 pl-6 text-[11px] leading-relaxed text-white/45">
        {hint}
        <span className="mt-0.5 block text-white/30">{note}</span>
      </p>
    </div>
  );
}

/**
 * The dot on the "กล้อง" button when either switch is off its default.
 *
 * Small on purpose. It answers "did I leave something turned on?" at a
 * glance, which is the only question a creator mid-broadcast has time for.
 */
export function OrientationChangedBadge() {
  return (
    <span
      aria-hidden
      className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-cyan-400 ring-2 ring-[#0a0a15]"
    />
  );
}
