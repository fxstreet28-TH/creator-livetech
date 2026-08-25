import type { Metadata } from 'next';
import { DashboardChrome } from '@/components/dashboard/DashboardChrome';

// Stays a Server Component purely so this export survives — Next.js rejects a
// `metadata` export from a module marked 'use client'. Nothing here touches a
// server-only API: the session read lives in DashboardChrome, which is what
// unblocks the static export build.
export const metadata: Metadata = {
  title: 'แดชบอร์ด — AURUM Live',
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <DashboardChrome>{children}</DashboardChrome>;
}
