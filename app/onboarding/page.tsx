// Placeholder redirect target for the signup flow.
// The full onboarding experience is a separate task — this only prevents a 404
// after a successful signup.
import Link from "next/link";

export const metadata = {
  title: "ตั้งค่าโปรไฟล์ — AURUM Live",
};

export default function OnboardingPage() {
  return (
    <main className="auth-page">
      <div className="auth-glow one" />
      <div className="auth-glow two" />
      <div className="auth-card" style={{ textAlign: "center" }}>
        <img className="auth-logo" src="/aurum-live-logo.png" alt="Aurum Live" />
        <div className="auth-head">
          <small>ONBOARDING</small>
          <h1>
            ยินดีต้อนรับสู่ <span>AURUM Live</span>
          </h1>
          <p>บัญชีของคุณพร้อมใช้งานแล้ว ขั้นตอนตั้งค่าโปรไฟล์กำลังจะมาเร็ว ๆ นี้</p>
        </div>
        <Link className="button" href="/dashboard" style={{ width: "100%" }}>
          ไปที่แดชบอร์ด <span>→</span>
        </Link>
        <Link className="auth-back" href="/">
          ← กลับหน้าหลัก
        </Link>
      </div>
    </main>
  );
}
