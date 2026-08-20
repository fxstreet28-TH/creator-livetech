/**
 * CORS headers for Edge Functions called from the browser and Capacitor shell.
 *
 * Capacitor origins: capacitor://localhost (iOS), http://localhost (Android).
 * Web origin: https://creatorlivetech.com and its Vercel previews.
 */

const ALLOWED_ORIGINS = new Set([
  'https://creatorlivetech.com',
  'capacitor://localhost',
  'http://localhost', // Android WebView
  'http://localhost:3000', // Local Next.js dev
]);

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/creator-livetech-[a-z0-9-]+-porforex599-8140s-projects\.vercel\.app$/,
];

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow =
    origin && (ALLOWED_ORIGINS.has(origin) || ALLOWED_ORIGIN_PATTERNS.some((r) => r.test(origin)))
      ? origin
      : 'https://creatorlivetech.com';

  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function preflightResponse(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}
