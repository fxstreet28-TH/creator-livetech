'use client';

/**
 * /wallet/buyback — sell stars back for THB, when the feature is on.
 *
 * Client Component for the same reason as /wallet/buy-stars: useRequireAuth
 * reads the session from the browser storage adapter, and the Capacitor build
 * has no server to read cookies on.
 *
 * BUYBACK_USER_ENABLED is a build-time constant, so the branch below is not a
 * conditional hook call — one of the two components mounts for the whole life
 * of the bundle, and the other is dead code the bundler can drop. The route
 * itself is kept in both cases; see BuybackClosedNotice for why.
 */

import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { WalletPageShell } from '@/components/wallet/WalletPageShell';
import { BuybackForm } from '@/components/wallet/BuybackForm';
import { BuybackClosedNotice } from '@/components/wallet/BuybackClosedNotice';
import { BUYBACK_USER_ENABLED } from '@/lib/features';

export default function BuybackPage() {
  if (!BUYBACK_USER_ENABLED) return <BuybackClosedNotice />;
  return <BuybackRequest />;
}

/**
 * Deliberately not auth-gated at the page level: the closed notice is public
 * copy pointing at a support channel, and asking someone to sign in before
 * they can be told the feature is unavailable helps nobody.
 */
function BuybackRequest() {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return (
    <WalletPageShell title="ขาย Stars คืน (Buyback)" subtitle="รับเงินโอนเข้าบัญชีธนาคาร">
      <BuybackForm />
    </WalletPageShell>
  );
}
