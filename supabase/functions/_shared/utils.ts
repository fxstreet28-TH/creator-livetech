/**
 * The helper set the deployed `content-*` and `live-*` Edge Functions share.
 *
 * This is the same module those functions already run against, brought into
 * the repo and given types. It is deployed alongside each function as
 * `../_shared/utils.ts`, which is the path they import — so the file here and
 * the file running in production are the same file, which was not true before
 * this PR.
 *
 * Note it is NOT the same thing as `_shared/auth.ts` and friends next to it:
 * those belong to the older signup/wallet functions, which have their own
 * conventions (typed envelopes, Thai copy). The two sets are kept apart on
 * purpose rather than merged mid-migration.
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-bunny-signature',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * The failure envelope every `live-*` and `content-*` function answers with.
 * Nested one level deeper than the wallet functions; lib/live/api.ts on the
 * client reads exactly this shape.
 */
export function errorResponse(message: string, status = 400, code?: string): Response {
  return jsonResponse({ error: { message, code: code ?? 'error' } }, status);
}

export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  return null;
}

export function getServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export function getUserClient(authHeader: string): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface AuthedUser {
  id: string;
  email: string | null;
}

export async function getAuthedUser(req: Request): Promise<AuthedUser | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const userClient = getUserClient(authHeader);
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return null;
  return { id: user.id, email: user.email ?? null };
}

export interface AuthedCreator {
  user: AuthedUser;
  creatorId: string;
  contentTier: string | null;
}

/**
 * Null for BOTH an invalid session and a signed-in user with no `creators`
 * row. Callers answer 401 for either — the creator gate on /creator/live rules
 * the second case out before any of these functions is reached.
 */
export async function getAuthedCreator(req: Request): Promise<AuthedCreator | null> {
  const user = await getAuthedUser(req);
  if (!user) return null;
  const serviceClient = getServiceClient();
  const { data: creator } = await serviceClient
    .from('creators')
    .select('id, content_tier')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!creator) return null;
  return { user, creatorId: creator.id, contentTier: creator.content_tier ?? null };
}

const _vaultCache = new Map<string, { value: string; expiresAt: number }>();
const VAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getVaultSecret(name: string): Promise<string> {
  const cached = _vaultCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const client = getServiceClient();
  const { data, error } = await client.rpc('get_vault_secret', { p_name: name });
  if (error || !data) throw new Error(`Vault secret not found: ${name}`);
  const value = data as string;
  _vaultCache.set(name, { value, expiresAt: Date.now() + VAULT_CACHE_TTL_MS });
  return value;
}

export async function getVaultSecrets(names: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const uncached = names.filter((n) => {
    const c = _vaultCache.get(n);
    if (c && c.expiresAt > Date.now()) {
      result[n] = c.value;
      return false;
    }
    return true;
  });
  if (uncached.length === 0) return result;

  const client = getServiceClient();
  const { data, error } = await client.rpc('get_vault_secrets', { p_names: uncached });
  if (error) throw new Error(`Failed to fetch vault secrets: ${error.message}`);
  for (const row of (data ?? []) as { name: string; decrypted_secret: string }[]) {
    result[row.name] = row.decrypted_secret;
    _vaultCache.set(row.name, {
      value: row.decrypted_secret,
      expiresAt: Date.now() + VAULT_CACHE_TTL_MS,
    });
  }
  return result;
}

/**
 * An optional secret, for a capability that may not be provisioned yet.
 *
 * getVaultSecret throws on a missing name, which is right for a credential the
 * function cannot work without and wrong for one that only turns an extra on
 * (see `bunny_stream_token_key` in ./live.ts).
 */
export async function tryGetVaultSecret(name: string): Promise<string | null> {
  try {
    return await getVaultSecret(name);
  } catch {
    return null;
  }
}

export const BUNNY_STREAM_API_BASE = 'https://video.bunnycdn.com/library';

/** Bunny and LiveKit are both fast or broken; nothing here should hang a request. */
export const EXTERNAL_API_TIMEOUT_MS = 10000;

/** fetch() with a deadline, because Deno's default is "wait forever". */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = EXTERNAL_API_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
