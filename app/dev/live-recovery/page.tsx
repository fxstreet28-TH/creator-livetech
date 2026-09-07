/**
 * /dev/live-recovery — the recovery ladder, without a broken phone.
 *
 * The ladder is thirty-five seconds of timing, three escalations and one
 * irreversible reload. None of that can be checked by reading it, and the
 * device it was written for is the one nobody can reproduce on demand — so the
 * health signal is a set of buttons here and the machine runs for real against
 * them.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT: `VERCEL_ENV` is not `NEXT_PUBLIC_`,
 * so a reference to it inside a client component is replaced with `undefined`
 * at build time — and `undefined !== 'production'` is TRUE, which would have
 * opened this page on production while looking exactly like a gate that
 * worked. Same reasoning, same shape, as the other /dev pages.
 */

import { notFound } from 'next/navigation';
import { RecoveryLadderBench } from './RecoveryLadderBench';

export default function DevLiveRecoveryPage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <RecoveryLadderBench />;
}
