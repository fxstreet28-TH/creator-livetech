import { NextResponse } from 'next/server';
import { getRouteHandlerSupabase } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Clears the session cookie written by /api/auth/login.
 *
 * TRANSITIONAL — delete this alongside /api/auth/login and middleware.ts once
 * the client-side route guard lands (audit PR 4 / PR 6). It exists only because
 * login still mints a cookie server-side while every other client path stores
 * the session through lib/storage/authStorage.ts; without it, signing out on
 * the browser client leaves that cookie behind and the middleware guard keeps
 * admitting the user.
 *
 * Always returns 200: a failed sign-out must not strand the user on a page they
 * have already been navigated away from.
 */
export async function POST() {
  try {
    const supabase = await getRouteHandlerSupabase();
    await supabase.auth.signOut();
  } catch (err) {
    console.error('[logout] cookie sign-out failed', err);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
