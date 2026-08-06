"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Cookie-based client so the session is readable by the route middleware
  // (server-side) that guards /dashboard and other protected routes.
  const supabase = useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      ),
    [],
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    setLoading(false);

    if (signInError) {
      setError("อีเมลหรือรหัสผ่านไม่ถูกต้อง กรุณาลองใหม่");
      return;
    }

    router.push(redirectTo);
    router.refresh();
  }

  return (
    <main className="auth-page">
      <div className="auth-glow one" aria-hidden />
      <div className="auth-glow two" aria-hidden />

      <div className="auth-card">
        <Link href="/" aria-label="AURUM LIVE หน้าหลัก">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="auth-logo" src="/aurum-live-logo.png" alt="Aurum Live" />
        </Link>

        <div className="auth-head">
          <small>WELCOME BACK</small>
          <h1>เข้าสู่<span>ระบบ</span></h1>
          <p>ยินดีต้อนรับกลับสู่ AURUM LIVE</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="email">
            อีเมล
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label htmlFor="password">
            รหัสผ่าน
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          <div className="auth-row">
            {/* ยังไม่ทำงานจริง — จะเชื่อมในภายหลัง */}
            <a href="#" onClick={(event) => event.preventDefault()}>
              ลืมรหัสผ่าน?
            </a>
          </div>

          {error && (
            <p
              role="alert"
              style={{
                margin: "4px 0 0",
                padding: "10px 14px",
                borderRadius: 10,
                background: "rgba(239,68,68,.1)",
                border: "1px solid rgba(239,68,68,.25)",
                color: "#fca5a5",
                fontSize: 13,
              }}
            >
              {error}
            </p>
          )}

          <button type="submit" className="button" disabled={loading}>
            {loading ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"} <span>→</span>
          </button>
        </form>

        <p className="auth-alt">
          ยังไม่มีบัญชี? <Link href="/?signup=open">สมัครสมาชิก</Link>
        </p>
        <Link className="auth-back" href="/">← กลับหน้าเว็บไซต์</Link>
      </div>
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
