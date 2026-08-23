/**
 * Small inline icons shared by the auth surfaces (/login, /reset-password and
 * the forgot-password modal).
 *
 * These are hand-rolled rather than pulled from lucide-react so that the auth
 * screens — the first paint a logged-out visitor gets — carry no icon-library
 * weight. They follow lucide's 24x24 / stroke-2 geometry so they sit visually
 * alongside the lucide icons used inside the dashboard.
 */

type IconProps = { size?: number };

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function ArrowRightIcon({ size }: IconProps = {}) {
  return (
    <Svg size={size}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Svg>
  );
}

export function AlertCircleIcon({ size = 14 }: IconProps = {}) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </Svg>
  );
}

export function MailIcon({ size = 22 }: IconProps = {}) {
  return (
    <Svg size={size}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </Svg>
  );
}

export function CheckIcon({ size = 22 }: IconProps = {}) {
  return (
    <Svg size={size}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps = {}) {
  return (
    <Svg size={size}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  );
}

/** The in-button loading indicator. Styled by `.aurum-spinner` in globals.css. */
export function Spinner() {
  return <span className="aurum-spinner" aria-hidden />;
}
