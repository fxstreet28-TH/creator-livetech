'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SignupModal } from './SignupModal';

function Opener() {
  const searchParams = useSearchParams();
  const router = useRouter();
  // Initialize open state from the URL once, at mount.
  const [open, setOpen] = useState(() => searchParams.get('signup') === 'open');

  useEffect(() => {
    // Strip the query param (replace, not push) so the modal doesn't re-open
    // when the user navigates back. No setState here — `open` already reflects
    // the param from the initializer above.
    if (searchParams.get('signup') === 'open') {
      router.replace('/', { scroll: false });
    }
  }, [searchParams, router]);

  return <SignupModal open={open} onClose={() => setOpen(false)} />;
}

/**
 * Opens the SignupModal on the landing page when the URL carries `?signup=open`
 * (used by the /login "สมัครสมาชิก" link to route new users into signup).
 */
export function SignupQueryOpener() {
  return (
    <Suspense fallback={null}>
      <Opener />
    </Suspense>
  );
}
