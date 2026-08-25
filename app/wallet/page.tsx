'use client';

import { ComingSoon } from '@/components/ComingSoon';
import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';

export default function WalletPage() {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return <ComingSoon title="กระเป๋าเงิน" />;
}
