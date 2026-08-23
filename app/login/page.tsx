"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiUrl } from "@/lib/config";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckIcon,
  Spinner,
} from "@/components/auth/AuthIcons";
import { ForgotPasswordModal } from "@/components/auth/ForgotPasswordModal";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/dashboard";
  // Set by /reset-password after a successful password change.
  const justReset = searchParams.get("reset") === "success";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Belt to the button's `disabled` braces: a double Enter press can queue a
    // second submit before React has re-rendered the disabled button.
    if (isSubmitting) return;
    setErrorMsg(null);
    setIsSubmitting(true);

    let res: Response;
    try {
      res = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
    } catch {
      setErrorMsg("เกิดข้อผิดพลาด กรุณาลองใหม่");
      setIsSubmitting(false);
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setErrorMsg(data?.error ?? "เกิดข้อผิดพลาด กรุณาลองใหม่");
      setIsSubmitting(false);
      return;
    }

    const body = await res.json().catch(() => null);

    if (body?.session) {
      const supabase = getBrowserSupabase();
      const { error: syncError } = await supabase.auth.setSession({
        access_token: body.session.access_token,
        refresh_token: body.session.refresh_token,
      });
      if (syncError) {
        // Cookie is set on the server but localStorage sync failed. Redirect
        // anyway — middleware will let the user in on the next request, and
        // the next auth-state-change event will resync. We surface no error
        // to the user because they *are* signed in on the server.
        console.warn("Login localStorage sync failed:", syncError);
      }
    }

    // Session cookies are now set by the server. Use `replace` (not `push`) so
    // the browser back button does not return the user to /login. Deliberately
    // no setIsSubmitting(false) here: the spinner has to stay up through the
    // redirect, otherwise the button flashes back to its enabled state.
    router.replace(redirectTo);
    router.refresh();
  }

  return (
    <main className="aurum-auth">
      <div className="aurum-auth__aurora" aria-hidden />

      <div className="aurum-auth__card">
        <Link
          className="aurum-auth__logo"
          href="/"
          aria-label="AURUM Live หน้าหลัก"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/aurum-live-logo.png" alt="AURUM Live" />
        </Link>

        <small className="aurum-auth__badge">Welcome back</small>
        <h1 className="aurum-auth__title">เข้าสู่ระบบ</h1>
        <p className="aurum-auth__subtitle">ยินดีต้อนรับกลับสู่ AURUM Live</p>

        {justReset && (
          <p className="aurum-auth__flash" role="status">
            <CheckIcon size={14} />
            <span>เปลี่ยนรหัสผ่านสำเร็จ กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่</span>
          </p>
        )}

        <form className="aurum-auth__form" onSubmit={handleSubmit}>
          <label className="aurum-auth__field" htmlFor="email">
            <span className="aurum-auth__label">อีเมล</span>
            <input
              id="email"
              className="aurum-auth__input"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              disabled={isSubmitting}
              onChange={(event) => {
                setErrorMsg(null);
                setEmail(event.target.value);
              }}
            />
          </label>

          <label className="aurum-auth__field" htmlFor="password">
            <span className="aurum-auth__label">รหัสผ่าน</span>
            <input
              id="password"
              className="aurum-auth__input"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              disabled={isSubmitting}
              onChange={(event) => {
                setErrorMsg(null);
                setPassword(event.target.value);
              }}
            />
          </label>

          <div className="aurum-auth__forgot-row">
            {/* A <button>, not an <a>: it opens the modal and must never
                navigate. */}
            <button
              type="button"
              className="aurum-auth__forgot"
              disabled={isSubmitting}
              onClick={() => setForgotOpen(true)}
            >
              ลืมรหัสผ่าน?
            </button>
          </div>

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
                กำลังเข้าสู่ระบบ...
              </>
            ) : (
              <>
                เข้าสู่ระบบ
                <ArrowRightIcon />
              </>
            )}
          </button>
        </form>

        {/* Links cannot be `disabled`, so they get the inert treatment instead:
            no pointer events, dimmed, for as long as the request is in flight. */}
        <p
          className={`aurum-auth__alt${isSubmitting ? " aurum-auth__inert" : ""}`}
        >
          ยังไม่มีบัญชี? <Link href="/?signup=open">สมัครสมาชิก</Link>
        </p>
        <p className="aurum-auth__trust">เข้ารหัส TLS · Supabase Auth</p>
        <Link
          className={`aurum-auth__back${isSubmitting ? " aurum-auth__inert" : ""}`}
          href="/"
        >
          ← กลับหน้าเว็บไซต์
        </Link>
      </div>

      <ForgotPasswordModal
        open={forgotOpen}
        onClose={() => setForgotOpen(false)}
      />
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
