'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { validatePassword } from '@/lib/validation';
import { AlertCircleIcon, ArrowRightIcon, Spinner } from '@/components/auth/AuthIcons';

type Phase = 'checking' | 'ready' | 'invalid';

const PASSWORD_ERROR: Record<NonNullable<ReturnType<typeof validatePassword>['reason']>, string> = {
  too_short: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร',
  need_letter: 'รหัสผ่านต้องมีตัวอักษรภาษาอังกฤษอย่างน้อย 1 ตัว',
  need_number: 'รหัสผ่านต้องมีตัวเลขอย่างน้อย 1 ตัว',
};

/**
 * Turns whatever Supabase put in the URL into a live recovery session.
 *
 * The shared browser client is built with `detectSessionInUrl: false` (there is
 * no OAuth redirect flow yet, and that module is deliberately not forked), so
 * nothing picks the recovery credentials out of the URL on our behalf — this
 * page has to do it. Two shapes can arrive:
 *
 *   implicit flow → #access_token=…&refresh_token=…&type=recovery
 *   PKCE flow     → ?code=…
 *
 * and an expired or already-used link arrives as an `error` / `error_code`
 * pair in either the hash or the query string.
 *
 * Returns true once a session exists. The credentials are wiped from the
 * address bar afterwards so they do not sit in browser history or leak through
 * a screenshot.
 */
async function establishRecoverySession(): Promise<boolean> {
  const supabase = getBrowserSupabase();

  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);

  const stripUrl = () =>
    window.history.replaceState(null, '', window.location.pathname);

  if (hash.get('error') || query.get('error')) {
    stripUrl();
    return false;
  }

  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    stripUrl();
    return !error;
  }

  const code = query.get('code');
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    stripUrl();
    return !error;
  }

  // No credentials in the URL. Either the link was already consumed on a
  // previous render (React re-running the effect) or the user opened
  // /reset-password directly — the live session tells the two apart.
  const { data } = await supabase.auth.getSession();
  return Boolean(data.session);
}

export default function ResetPasswordPage() {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = getBrowserSupabase();

    // Belt to the URL parsing above: if a future change ever turns
    // detectSessionInUrl on, the client will have consumed the link itself and
    // announce it here instead.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (cancelled) return;
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') setPhase('ready');
    });

    establishRecoverySession().then(
      (ok) => {
        if (!cancelled) setPhase(ok ? 'ready' : 'invalid');
      },
      () => {
        if (!cancelled) setPhase('invalid');
      },
    );

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setErrorMsg(null);

    const check = validatePassword(password);
    if (!check.ok) {
      setErrorMsg(PASSWORD_ERROR[check.reason!]);
      return;
    }
    if (password !== confirm) {
      setErrorMsg('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
      return;
    }

    setIsSubmitting(true);
    const supabase = getBrowserSupabase();
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setErrorMsg(`ไม่สามารถเปลี่ยนรหัสผ่านได้ ${error.message}`);
      setIsSubmitting(false);
      return;
    }

    // Drop the recovery session so /login is reached signed out and the user
    // proves the new password works. This also revokes the account's other
    // refresh tokens, which is what you want after a password reset.
    await supabase.auth.signOut();

    // `replace`, not `push`: the recovery link is spent, so going "back" to
    // this page would only land on the expired-link state.
    router.replace('/login?reset=success');
  }

  return (
    <main className="aurum-auth">
      <div className="aurum-auth__aurora" aria-hidden />

      <div className="aurum-auth__card">
        <Link className="aurum-auth__logo" href="/" aria-label="AURUM Live หน้าหลัก">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/aurum-live-logo.png" alt="AURUM Live" />
        </Link>

        {phase === 'checking' && (
          <>
            <small className="aurum-auth__badge">Reset password</small>
            <h1 className="aurum-auth__title">กำลังตรวจสอบลิงก์</h1>
            <p className="aurum-auth__subtitle">กรุณารอสักครู่...</p>
          </>
        )}

        {phase === 'invalid' && (
          <>
            <small className="aurum-auth__badge">Reset password</small>
            <h1 className="aurum-auth__title">ลิงก์หมดอายุหรือไม่ถูกต้อง</h1>
            <p className="aurum-auth__subtitle">
              ลิงก์รีเซ็ตรหัสผ่านมีอายุ 1 ชั่วโมง และใช้ได้ครั้งเดียว
              <br />
              กรุณาขอลิงก์ใหม่จากหน้าเข้าสู่ระบบ
            </p>
            <Link className="aurum-auth__back" href="/login">
              ← กลับไปหน้าเข้าสู่ระบบ
            </Link>
          </>
        )}

        {phase === 'ready' && (
          <>
            <small className="aurum-auth__badge">Reset password</small>
            <h1 className="aurum-auth__title">ตั้งรหัสผ่านใหม่</h1>
            <p className="aurum-auth__subtitle">
              ตั้งรหัสผ่านใหม่สำหรับบัญชี AURUM Live ของคุณ
            </p>

            {/* noValidate: validatePassword() below owns the rules and speaks
                Thai; `required` stays as a hint for assistive tech. */}
            <form className="aurum-auth__form" noValidate onSubmit={handleSubmit}>
              <label className="aurum-auth__field" htmlFor="new-password">
                <span className="aurum-auth__label">รหัสผ่านใหม่</span>
                <input
                  id="new-password"
                  className="aurum-auth__input"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="อย่างน้อย 8 ตัวอักษร"
                  value={password}
                  disabled={isSubmitting}
                  onChange={(event) => {
                    setErrorMsg(null);
                    setPassword(event.target.value);
                  }}
                />
              </label>

              <label className="aurum-auth__field" htmlFor="confirm-password">
                <span className="aurum-auth__label">ยืนยันรหัสผ่านใหม่</span>
                <input
                  id="confirm-password"
                  className="aurum-auth__input"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="พิมพ์รหัสผ่านอีกครั้ง"
                  value={confirm}
                  disabled={isSubmitting}
                  onChange={(event) => {
                    setErrorMsg(null);
                    setConfirm(event.target.value);
                  }}
                />
              </label>

              {errorMsg && (
                <p className="aurum-auth__error" role="alert">
                  <AlertCircleIcon />
                  <span>{errorMsg}</span>
                </p>
              )}

              <button
                type="submit"
                className="aurum-auth__submit"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Spinner />
                    กำลังบันทึก...
                  </>
                ) : (
                  <>
                    บันทึกรหัสผ่านใหม่
                    <ArrowRightIcon />
                  </>
                )}
              </button>
            </form>

            <p className="aurum-auth__trust">เข้ารหัส TLS · Supabase Auth</p>
            <Link
              className={`aurum-auth__back${isSubmitting ? ' aurum-auth__inert' : ''}`}
              href="/login"
            >
              ← กลับไปหน้าเข้าสู่ระบบ
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
