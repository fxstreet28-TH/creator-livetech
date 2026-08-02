import type { Metadata } from "next";
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
