import type { NextConfig } from 'next';

const isCapacitorBuild = process.env.NEXT_PUBLIC_CAPACITOR_BUILD === 'true';

const nextConfig: NextConfig = {
  // Static export mode ONLY when building for Capacitor.
  // Vercel web builds leave this off so SSR, API routes, and middleware still work.
  ...(isCapacitorBuild && {
    output: 'export',
    trailingSlash: true, // emits /login/index.html, which WebViewLocalServer handles reliably
    images: { unoptimized: true }, // the default next/image loader is incompatible with output:'export'
  }),
};

export default nextConfig;
