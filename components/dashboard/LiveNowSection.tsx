'use client';

/**
 * "🔴 กำลังไลฟ์ตอนนี้" — real `live_sessions` rows, replacing the six mock
 * sessions with invented viewer counts that used to live here.
 *
 * The section renders NOTHING when nothing is live, rather than an empty-state
 * tile. `live_sessions` has no rows at all until Day 7-8 ships live streaming,
 * so an empty state here would be the permanent look of the homepage's first
 * section for the whole of launch week, and a homepage that leads with an
 * empty box reads as broken. It reappears by itself the moment a session goes
 * on air.
 */

import Link from 'next/link';
import { useLiveSessions } from '@/lib/hooks/useLiveSessions';
import { LiveSessionCard } from '@/components/viewer/LiveSessionGrid';

export function LiveNowSection() {
  const { sessions, loading } = useLiveSessions(8);

  // Nothing on air, or the read failed: either way there is nothing to show,
  // and a failed lookup of an empty table is not worth an error banner on the
  // homepage. The console.error in the query wrapper is the record.
  if (loading || sessions.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">🔴 กำลังไลฟ์ตอนนี้</h2>
        <Link
          href="/discover?tab=live"
          className="text-sm text-purple-300 transition hover:text-purple-200"
        >
          ดูทั้งหมด →
        </Link>
      </div>
      <div className="mt-4 flex snap-x gap-4 overflow-x-auto pb-2">
        {sessions.map((session) => (
          <div key={session.id} className="w-64 shrink-0 snap-start">
            <LiveSessionCard session={session} />
          </div>
        ))}
      </div>
    </section>
  );
}
