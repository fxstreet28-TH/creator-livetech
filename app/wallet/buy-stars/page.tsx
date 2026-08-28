'use client';

/**
 * /wallet/buy-stars — buy stars with PromptPay.
 *
 * A Client Component, like every other protected page in the app. The Week 3
 * brief called for a Server Component shell, but useRequireAuth reads the
 * session from the browser storage adapter (localStorage on web,
 * @capacitor/preferences on native) rather than from cookies, and the
 * Capacitor build runs `output: 'export'` with no server to read them on.
 * See the comment block in lib/hooks/useRequireAuth.tsx.
 */

import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { WalletPageShell } from '@/components/wallet/WalletPageShell';
import { BuyStarsForm } from '@/components/wallet/BuyStarsForm';

export default function BuyStarsPage() {
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return (
    <WalletPageShell title="ซื้อ Stars" subtitle="ชำระผ่าน PromptPay QR">
      <BuyStarsForm />
    </WalletPageShell>
  );
}
