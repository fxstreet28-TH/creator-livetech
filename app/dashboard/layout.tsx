import type { Metadata } from 'next';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { getDashboardUser } from '@/lib/session';

export const metadata: Metadata = {
  title: 'แดชบอร์ด — AURUM Live',
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getDashboardUser();
  return (
    <DashboardShell displayName={user.displayName} email={user.email} avatarUrl={user.avatarUrl}>
      {children}
    </DashboardShell>
  );
}
