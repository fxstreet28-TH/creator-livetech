/**
 * /dev/creator-live — the phone HOST layout, without a broadcast.
 *
 * The same argument as /dev/live-mobile, applied to the other side of the
 * glass: checking that "จบไลฟ์" is reachable on a 375px screen should not need
 * a creator on air, a funded wallet and a second device.
 *
 * Everything below the fake props is the real tree — CreatorLiveMobile,
 * CreatorBroadcaster, the real camera pipeline through createFilteredStream.
 * The LiveKit connection is the one thing that cannot work here, and that is
 * itself worth seeing: the connection overlay is what a creator stares at
 * while a room comes up, and the end button has to be on top of it.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT: `VERCEL_ENV` is not `NEXT_PUBLIC_`,
 * so a reference to it inside a client component is replaced with `undefined`
 * at build time — and `undefined !== 'production'` is TRUE, which would have
 * opened this page on production while looking exactly like a gate that
 * worked. Same reasoning, same shape, as /dev/live-mobile.
 */

import { notFound } from 'next/navigation';
import { CreatorLiveMobileBench } from './CreatorLiveMobileBench';

export default function DevCreatorLivePage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <CreatorLiveMobileBench />;
}
