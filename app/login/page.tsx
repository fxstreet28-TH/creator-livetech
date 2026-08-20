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

          <button type="submit" className="button" disabled={isSubmitting}>
            {isSubmitting ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"} <span>→</span>
          </button>

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
