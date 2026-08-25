'use client';

import { ComingSoon } from '@/components/ComingSoon';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';

export default function SettingsPage() {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return <ComingSoon title="ตั้งค่า" />;
}
