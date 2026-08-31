/**
 * /c/[handle] — the creator's public profile. A PLACEHOLDER for now; see
 * CreatorProfilePlaceholder for what it does and does not do.
 *
 * Server Component wrapper for the same reason as /posts/[id]:
 * `generateStaticParams` cannot be exported from a 'use client' module, and
 * the Capacitor `output: 'export'` build requires it on every dynamic segment.
 */

import { CreatorProfilePlaceholder } from '@/components/viewer/CreatorProfilePlaceholder';

/** See the note in app/posts/[id]/page.tsx — an empty array fails the export. */
export function generateStaticParams() {
  return [{ handle: 'placeholder' }];
}

export default async function CreatorProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return <CreatorProfilePlaceholder handle={decodeURIComponent(handle)} />;
}
