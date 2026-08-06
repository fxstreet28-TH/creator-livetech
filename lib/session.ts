import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

export interface DashboardUser {
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

/**
 * Reads the signed-in user from the Supabase session cookie for server
 * components. Wrapped in React `cache` so the layout and page share a single
 * lookup per request. Falls back gracefully (no throw) when there is no session
 * or Supabase env — the dashboard still renders with a friendly default name.
 */
export const getDashboardUser = cache(async (): Promise<DashboardUser> => {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          // Server Components cannot set cookies; middleware refreshes them.
          setAll: () => {},
        },
      },
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const email = user?.email ?? null;
    const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
    const displayName =
      (typeof meta.display_name === 'string' && meta.display_name) ||
      (typeof meta.full_name === 'string' && meta.full_name) ||
      (email ? email.split('@')[0] : '') ||
      'เพื่อน';
    const avatarUrl = typeof meta.avatar_url === 'string' ? meta.avatar_url : null;

    return { displayName, email, avatarUrl };
  } catch {
    return { displayName: 'เพื่อน', email: null, avatarUrl: null };
  }
});
