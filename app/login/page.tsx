"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiUrl } from "@/lib/config";
import { getBrowserSupabase } from "@/lib/supabase-browser";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    // the browser back button does not return the user to /login. Keep
    // isSubmitting true through the redirect to avoid a button flash.
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
              onChange={(event) => setEmail(event.target.value)}
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
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          <div className="aurum-auth__forgot-row">
            {/* A <button>, not an <a>: it opens a modal (wired up in the
                forgot-password commit) and must never navigate. */}
            <button type="button" className="aurum-auth__forgot">
              ลืมรหัสผ่าน?
            </button>
          </div>

          {errorMsg && (
            <p
              role="alert"
              style={{
                margin: "12px 0 0",
                padding: "10px 14px",
                borderRadius: 10,
                background: "rgba(239,68,68,.1)",
                border: "1px solid rgba(239,68,68,.25)",
                color: "#fca5a5",
                fontSize: 13,
              }}
            >
              {errorMsg}
            </p>
          )}

          <button type="submit" className="aurum-auth__submit" disabled={isSubmitting}>
            {isSubmitting ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"}
            <ArrowRightIcon />
          </button>
        </form>

        <p className="aurum-auth__alt">
          ยังไม่มีบัญชี? <Link href="/?signup=open">สมัครสมาชิก</Link>
        </p>
        <p className="aurum-auth__trust">เข้ารหัส TLS · Supabase Auth</p>
        <Link className="aurum-auth__back" href="/">
          ← กลับหน้าเว็บไซต์
        </Link>
      </div>
    </main>
  );
}

function ArrowRightIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
