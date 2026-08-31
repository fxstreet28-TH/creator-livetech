import ReactDOM from "react-dom";
import type { Metadata, Viewport } from "next";
import { FeedbackWidget } from "@/components/feedback/FeedbackWidget";
import { KillSwitchBanner } from "@/components/platform/KillSwitchBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aurum Live — แพลตฟอร์มสำหรับครีเอเตอร์",
  description: "สร้างชุมชน เติบโต และจัดการไลฟ์อย่างมืออาชีพด้วย Aurum Live",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/aurum-live-logo.png",
    shortcut: "/aurum-live-logo.png",
  },
};

/**
 * viewportFit: 'cover' lets the page paint under the iOS notch / Dynamic Island
 * and home indicator, which is what makes env(safe-area-inset-*) resolve to
 * real values instead of 0px. The .safe-* utilities in globals.css and the
 * inset-aware paddings on the dashboard chrome depend on this being set.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The body font is Thai-first, so the regular weight is on the critical path
  // for every screen. ReactDOM.preload emits the <link> into <head> once; a
  // literal <link> in the tree gets hoisted *and* kept, which duplicates it.
  ReactDOM.preload("/fonts/noto-sans-thai/NotoSansThai-Regular.woff2", {
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  });

  return (
    <html lang="th">
      <body>
        {/* First in the body and fixed to the top: it outranks every page's own
            chrome, which is the point — it is the platform talking, not a
            screen. Renders nothing while the budget status is 'normal'. */}
        <KillSwitchBanner />
        {children}
        {/* Global, and last in the body so its fixed layers stack over the page
            without needing a z-index above the app's own. Renders nothing at
            all until there is a session, so it costs a signed-out visitor one
            null component. */}
        <FeedbackWidget />
      </body>
    </html>
  );
}
