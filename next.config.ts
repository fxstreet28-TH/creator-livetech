import type { NextConfig } from 'next';

const isCapacitorBuild = process.env.NEXT_PUBLIC_CAPACITOR_BUILD === 'true';

const nextConfig: NextConfig = {
  /**
   * The commit this bundle is built from, inlined into the client.
   *
   * Through `env` rather than relying on Vercel's automatic
   * NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA mirror, which is a project setting
   * someone can turn off — and a stale-build guard that silently stops
   * working is worse than not having one. See lib/live/buildId.ts.
   */
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev',
  },
  // Static export mode ONLY when building for Capacitor.
  // Vercel web builds leave this off so SSR and the /api/auth route handlers still work.
  ...(isCapacitorBuild && {
    output: 'export',
    trailingSlash: true, // emits /login/index.html, which WebViewLocalServer handles reliably
    images: { unoptimized: true }, // the default next/image loader is incompatible with output:'export'
  }),
};

export default nextConfig;
