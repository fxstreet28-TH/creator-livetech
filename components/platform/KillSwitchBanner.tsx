'use client';

/**
 * The platform-wide status bar, mounted once in the root layout.
 *
 * Renders nothing at all while the platform is 'normal', which is almost
 * always. The four states it does render for escalate: 'warning' is a heads-up
 * a user may dismiss, the other three are conditions they need to keep seeing
 * because the app is behaving differently while they hold.
 *
 * The dismissal is component state and nothing else (non-negotiable #5, #8):
 * a reload brings the banner back, and it comes back on its own the moment the
 * status changes, because the collapsed flag is keyed to the status it was
 * dismissed for.
 *
 * Fixed rather than in flow so it holds while a page scrolls. What keeps it
 * from covering the app's own header is --kill-switch-h: the banner measures
 * itself into that custom property, and body / TopBar / the desktop sidebar
 * offset themselves by it (see globals.css). At 'normal' the property is
 * absent and every one of those calc()s collapses to what it was before.
 */

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { usePlatformStatus } from '@/lib/hooks/usePlatformStatus';
import {
  platformStatusMessage,
  shouldShowBanner,
  type PlatformStatus,
  type PlatformStatusName,
} from '@/lib/platform/status';

interface BannerStyle {
  /** Text, not an icon font: these carry their own colour at any size. */
  emoji: string;
  /** Solid tint + blur, so page content never shows through the copy. */
  className: string;
  dismissible: boolean;
  /** Non-dismissible states are conditions, not notices. */
  role: 'status' | 'alert';
}

const STYLES: Record<Exclude<PlatformStatusName, 'normal'>, BannerStyle> = {
  warning: {
    emoji: 'ℹ️',
    className: 'border-amber-300/30 bg-amber-500/20 text-amber-50',
    dismissible: true,
    role: 'status',
  },
  degraded: {
    emoji: '⚠️',
    className: 'border-orange-400/35 bg-orange-600/30 text-orange-50',
    dismissible: false,
    role: 'status',
  },
  emergency: {
    emoji: '🚫',
    className: 'border-rose-400/40 bg-rose-600/35 text-rose-50',
    dismissible: false,
    role: 'alert',
  },
  readonly: {
    emoji: '🔒',
    className: 'border-red-400/45 bg-red-950/90 text-red-50',
    dismissible: false,
    role: 'alert',
  },
};

export function KillSwitchBanner() {
  const { status } = usePlatformStatus();
  /** The status this user dismissed, if any. A new status shows again. */
  const [dismissed, setDismissed] = useState<PlatformStatusName | null>(null);

  if (!shouldShowBanner(status) || !status) return null;
  if (dismissed === status.status) return null;

  return <Banner status={status} onDismiss={() => setDismissed(status.status)} />;
}

function Banner({ status, onDismiss }: { status: PlatformStatus; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const style = STYLES[status.status as Exclude<PlatformStatusName, 'normal'>];

  // Publish the banner's real height so the rest of the app can move out from
  // under it. Measured rather than hardcoded because the copy wraps to two or
  // three lines on a narrow phone, and a fixed 44px would cover the top bar
  // exactly when the message is longest.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const apply = () => {
      document.documentElement.style.setProperty(
        '--kill-switch-h',
        `${element.offsetHeight}px`,
      );
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);

    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--kill-switch-h');
    };
  }, []);

  return (
    <div
      ref={ref}
      role={style.role}
      // safe-top rather than a plain padding: on a notched iPhone the banner
      // is the topmost thing on screen, so it owns the inset.
      className={`safe-x fixed inset-x-0 top-0 z-50 border-b px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-md ${style.className}`}
    >
      <div className="mx-auto flex w-full max-w-5xl items-start gap-3">
        <span aria-hidden className="shrink-0 text-base leading-6">
          {style.emoji}
        </span>
        <p className="min-w-0 flex-1 text-sm font-medium leading-6">
          {platformStatusMessage(status)}
        </p>
        {style.dismissible && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="ปิดข้อความแจ้งเตือน"
            className="-my-2 -mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-lg transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          >
            <X size={18} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
