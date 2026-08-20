import type { Metadata, Viewport } from "next";
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
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
