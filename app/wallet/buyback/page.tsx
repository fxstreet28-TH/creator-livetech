'use client';

/**
 * /wallet/buyback — sell stars back for THB.
 *
 * Client Component for the same reason as /wallet/buy-stars: useRequireAuth
 * reads the session from the browser storage adapter, and the Capacitor build
 * has no server to read cookies on.
 */

import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { WalletPageShell } from '@/components/wallet/WalletPageShell';
import { BuybackForm } from '@/components/wallet/BuybackForm';

export default function BuybackPage() {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return (
    <WalletPageShell title="ขาย Stars คืน (Buyback)" subtitle="รับเงินโอนเข้าบัญชีธนาคาร">
      <BuybackForm />
    </WalletPageShell>
  );
}
