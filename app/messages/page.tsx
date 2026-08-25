'use client';

import { ComingSoon } from '@/components/ComingSoon';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';

export default function MessagesPage() {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return <ComingSoon title="ข้อความ" />;
}
