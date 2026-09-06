'use client';

/**
 * "What time does the DATABASE think it is?" — as an offset to add to
 * `Date.now()`.
 *
 * WHY A PAGE NEEDS THIS. The watch page decides whether a session claiming to
 * be live has gone quiet by comparing `last_heartbeat_at` to now. Do that
 * against the device clock and a viewer whose phone is a couple of minutes
 * fast is shown "ไลฟ์จบแล้ว" over a broadcast that is running — and it never
 * recovers, because every poll makes the same comparison and reaches the same
 * wrong answer. Device clocks are wrong often enough that this is not a
 * theoretical worry: a phone that has been off, a desktop with no NTP, a VM
 * resumed from a snapshot.
 *
 * The listing does not need this — `list_discoverable_live_sessions` makes its
 * freshness cut inside Postgres. Only the single-row read does, because it
 * goes through RLS and cannot be an RPC without losing the entitlement rules.
 *
 * ONE CALL, NOT A CLOCK. The offset is read once and kept: drift between two
 * machines over a broadcast is milliseconds, and polling a clock to check the
 * time is how you turn a correctness fix into a load problem. The round trip
 * itself is halved out — the server's answer arrives some time after the
 * request left, and the truth is somewhere in the middle — which is the same
 * (much simplified) idea NTP uses.
 *
 * FAILS TO ZERO. A refused or slow RPC leaves the offset at 0, which is
 * exactly today's behaviour: the device clock, unadjusted. Nothing about this
 * is worth blocking a page render for.
 */

import { useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';

/**
 * Milliseconds to ADD to `Date.now()` to get the server's clock.
 *
 * 0 until measured, and 0 forever if it cannot be — see the header.
 */
export function useServerClockOffset(): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function measure() {
      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        return;
      }

      const sentAt = Date.now();
      const { data, error } = await supabase.rpc('server_now');
      if (cancelled || error || typeof data !== 'string') return;

      const serverMs = Date.parse(data);
      if (Number.isNaN(serverMs)) return;

      // The server answered at some point between the request leaving and the
      // reply landing; the midpoint is the best single guess available without
      // a second exchange.
      const roundTrip = Date.now() - sentAt;
      const next = Math.round(serverMs + roundTrip / 2 - Date.now());

      // Sub-second disagreement is noise, and re-rendering the page for it
      // would be worse than ignoring it. Only a real skew is worth correcting.
      if (Math.abs(next) < 1000) return;
      setOffset(next);
    }

    void measure();
    return () => {
      cancelled = true;
    };
  }, []);

  return offset;
}
