"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // TODO: connect Supabase auth in future PR
    // ตอนนี้เป็น mockup เท่านั้น: ยังไม่ตรวจสอบ email/password จริง
    // เมื่อทำ backend แล้วให้ verify ก่อนแล้วค่อย redirect
    router.push("/dashboard");
  }

  return (
    <main className="auth-page">
      <div className="auth-glow one" aria-hidden />
      <div className="auth-glow two" aria-hidden />

      <div className="auth-card">
        <a href="/" aria-label="AURUM LIVE หน้าหลัก">
          <img className="auth-logo" src="/aurum-live-logo.png" alt="Aurum Live" />
        </a>

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

          <button type="submit" className="button">
            เข้าสู่ระบบ <span>→</span>
          </button>
        </form>

        <p className="auth-alt">
          ยังไม่มีบัญชี? <a href="/creator/apply">สมัครสมาชิก</a>
        </p>
        <a className="auth-back" href="/">← กลับหน้าเว็บไซต์</a>
      </div>
    </main>
  );
}
