"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import styles from "./signup.module.css";

type ApiResult = { ok: boolean; message?: string; challengeId?: string; accountId?: string };

async function post(path: string, body: Record<string, unknown>): Promise<ApiResult> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

export default function SignupPage() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [challengeId, setChallengeId] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  async function submitStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true); setMessage(""); setIsError(false);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirmPassword"))) {
      setLoading(false); setIsError(true); setMessage("รหัสผ่านทั้งสองช่องไม่ตรงกัน"); return;
    }
    const result = await post("/api/auth/register/start", {
      fullName: form.get("fullName"), email: form.get("email"), phone: form.get("phone"), password,
    });
    setLoading(false);
    if (!result.ok || !result.challengeId) { setIsError(true); setMessage(result.message || "เริ่มสมัครไม่สำเร็จ"); return; }
    setChallengeId(result.challengeId); setStep(2); setMessage("ส่งรหัสไปยัง Email และเบอร์โทรแล้ว รหัสมีอายุ 5 นาที");
  }

  async function verifyEmail(event: FormEvent) {
    event.preventDefault(); setLoading(true); setMessage(""); setIsError(false);
    const result = await post("/api/auth/register/verify-email", { challengeId, code: emailCode });
    setLoading(false);
    if (!result.ok) { setIsError(true); setMessage(result.message || "ยืนยัน Email ไม่สำเร็จ"); return; }
    setStep(3); setMessage("ยืนยัน Email สำเร็จ กรุณายืนยันเบอร์โทรต่อ");
  }

  async function verifyPhone(event: FormEvent) {
    event.preventDefault(); setLoading(true); setMessage(""); setIsError(false);
    const result = await post("/api/auth/register/verify-phone", { challengeId, code: phoneCode });
    if (!result.ok) { setLoading(false); setIsError(true); setMessage(result.message || "ยืนยันเบอร์ไม่สำเร็จ"); return; }
    const complete = await post("/api/auth/register/complete", { challengeId });
    setLoading(false);
    if (!complete.ok) { setIsError(true); setMessage(complete.message || "สร้างบัญชีไม่สำเร็จ"); return; }
    setStep(4); setMessage("");
  }

  return <main className={styles.page}>
    <div className={styles.shell}>
      <aside className={styles.aside}>
        <div className={styles.brand}>CREATOR LIVETECH</div>
        <h1>เริ่มต้นพื้นที่<br/>ของคุณ</h1>
        <p>สร้างบัญชีสมาชิกที่ปลอดภัย พร้อมการยืนยันตัวตนทั้ง Email และเบอร์โทรศัพท์</p>
        <div className={styles.steps}>
          <div className={`${styles.step} ${step >= 1 ? styles.active : ""}`}><span>1</span>ข้อมูลบัญชี</div>
          <div className={`${styles.step} ${step >= 2 ? styles.active : ""}`}><span>2</span>ยืนยัน Email</div>
          <div className={`${styles.step} ${step >= 3 ? styles.active : ""}`}><span>3</span>ยืนยันเบอร์โทร</div>
        </div>
      </aside>
      <section className={styles.card}>
        {step === 1 && <><h2>สมัครสมาชิก</h2><p className={styles.sub}>กรอกข้อมูลจริงเพื่อสร้างบัญชี Creator LiveTech</p>
          <form className={styles.form} onSubmit={submitStart}>
            <div className={styles.field}><label htmlFor="fullName">ชื่อ-นามสกุล</label><input id="fullName" name="fullName" autoComplete="name" required minLength={2}/></div>
            <div className={styles.grid}>
              <div className={styles.field}><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="email" required onChange={e=>setEmail(e.target.value)}/></div>
              <div className={styles.field}><label htmlFor="phone">เบอร์โทรศัพท์</label><input id="phone" name="phone" inputMode="tel" autoComplete="tel" placeholder="0812345678" required onChange={e=>setPhone(e.target.value)}/></div>
            </div>
            <div className={styles.grid}>
              <div className={styles.field}><label htmlFor="password">รหัสผ่าน</label><input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required/></div>
              <div className={styles.field}><label htmlFor="confirmPassword">ยืนยันรหัสผ่าน</label><input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required/></div>
            </div>
            <label className={styles.check}><input type="checkbox" required/>ฉันยอมรับข้อกำหนดการใช้งานและรับทราบนโยบายความเป็นส่วนตัว รวมถึงการใช้ข้อมูลเพื่อยืนยันบัญชี</label>
            {message && <div className={`${styles.notice} ${isError ? styles.error : ""}`}>{message}</div>}
            <button className={styles.button} disabled={loading}>{loading ? "กำลังส่ง OTP..." : "สมัครและส่งรหัสยืนยัน"}</button>
          </form></>}
        {step === 2 && <><h2>ยืนยัน Email</h2><p className={styles.sub}>กรอกรหัส 6 หลักที่ส่งไปยัง {email}</p>
          <form className={styles.form} onSubmit={verifyEmail}><div className={styles.field}><label htmlFor="emailCode">Email OTP</label><input id="emailCode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={emailCode} onChange={e=>setEmailCode(e.target.value.replace(/\D/g,""))} required/></div>
          {message && <div className={`${styles.notice} ${isError ? styles.error : ""}`}>{message}</div>}<button className={styles.button} disabled={loading}>{loading ? "กำลังตรวจสอบ..." : "ยืนยัน Email"}</button></form></>}
        {step === 3 && <><h2>ยืนยันเบอร์โทร</h2><p className={styles.sub}>กรอกรหัส 6 หลักจาก Movider ที่ส่งไปยัง {phone}</p>
          <form className={styles.form} onSubmit={verifyPhone}><div className={styles.field}><label htmlFor="phoneCode">SMS OTP</label><input id="phoneCode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={phoneCode} onChange={e=>setPhoneCode(e.target.value.replace(/\D/g,""))} required/></div>
          {message && <div className={`${styles.notice} ${isError ? styles.error : ""}`}>{message}</div>}<button className={styles.button} disabled={loading}>{loading ? "กำลังสร้างบัญชี..." : "ยืนยันเบอร์และสร้างบัญชี"}</button></form></>}
        {step === 4 && <div className={styles.success}><div className={styles.successMark}>✓</div><h2>สร้างบัญชีสำเร็จ</h2><p className={styles.sub}>Email และเบอร์โทรของคุณได้รับการยืนยันเรียบร้อยแล้ว</p><Link className={styles.button} href="/dashboard">ไปยังแดชบอร์ด</Link></div>}
      </section>
    </div>
  </main>;
}
