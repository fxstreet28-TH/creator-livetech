import { serviceClient } from './supabase.ts';

export interface AuthedUser {
  id: string;
  email: string | null;
  phone: string | null;
}

/**
 * Extract and verify the Supabase JWT from the Authorization header.
 * Returns the user, or null if unauthenticated / invalid.
 *
 * Use this in Edge Functions that require the caller to be signed in.
 * Signup / login functions do NOT use this — they establish the session.
 */
export async function getAuthedUser(req: Request): Promise<AuthedUser | null> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);

  const supabase = serviceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    phone: data.user.phone ?? null,
  };
}
