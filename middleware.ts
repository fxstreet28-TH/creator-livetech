import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Route guard: unauthenticated users hitting a protected route are redirected
// to /login?redirect=<path>. Uses the @supabase/ssr getAll/setAll cookie API
// (the interface required by @supabase/ssr >= 0.4; the older get/set/remove
// interface is not supported by the installed 0.12.x).
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
          res = NextResponse.next({ request: req });
          cookiesToSet.forEach(({ name, value, options }) =>
            res.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const protectedPaths = [
    '/dashboard',
    '/wallet',
    '/settings',
    '/subscriptions',
    '/following',
    '/messages',
    '/creator/apply',
  ];
  const isProtected = protectedPaths.some((p) => req.nextUrl.pathname.startsWith(p));

  if (isProtected && !user) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('redirect', req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return res;
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/wallet/:path*',
    '/settings/:path*',
    '/subscriptions/:path*',
    '/following/:path*',
    '/messages/:path*',
    '/creator/apply/:path*',
  ],
};
