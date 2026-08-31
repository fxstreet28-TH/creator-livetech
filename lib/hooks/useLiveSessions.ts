'use client';

/**
 * Sessions that are on air, for the dashboard's "🔴 กำลังไลฟ์ตอนนี้" strip and
 * /discover's live tab.
 *
 * `live_sessions` has no rows until Day 7-8 ships live streaming, so the
 * empty result is the expected one. Consumers hide their section rather than
 * render an empty one — an empty section on a homepage reads as broken.
 */

import { useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { fetchLiveSessions } from '@/lib/viewer/publicFeed';
import type { LiveSessionSummary } from '@/lib/viewer/types';

export interface LiveSessionsResult {
  sessions: LiveSessionSummary[];
  loading: boolean;
  error: string | null;
}

export function useLiveSessions(limit = 8): LiveSessionsResult {
  const [sessions, setSessions] = useState<LiveSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let supabase;
      try {
        supabase = getBrowserSupabase();
      } catch {
        if (!cancelled) {
          setError('ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง');
          setLoading(false);
        }
        return;
      }

      const result = await fetchLiveSessions(supabase, limit);
      if (cancelled) return;

      setSessions(result.sessions);
      setError(result.error);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [limit]);

  return { sessions, loading, error };
}
