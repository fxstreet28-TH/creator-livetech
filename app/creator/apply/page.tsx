'use client';

import { AuthPending, useRequireAuth } from '@/lib/hooks/useRequireAuth';

const steps = ["ข้อมูลบัญชี", "ข้อมูลช่อง", "ยืนยันตัวตน", "ส่งให้ตรวจสอบ"];

export default function CreatorApplyPage() {
  // Kept protected to match the deleted middleware matcher exactly. The audit
  // (docs/capacitor-audit.md, open question 4) flags whether this page should
  // be public at all — that is a product call, not part of this cleanup.
  const { ready } = useRequireAuth();
  if (!ready) return <AuthPending />;

  return (
    <main className="portal-page">
      <header className="portal-nav">
        <a href="/"><img src="/aurum-live-logo.png" alt="Aurum Live" /></a>
        <div><a href="/explore">ค้นหา Creator</a><a className="active" href="/creator/apply">สมัครเป็น Creator</a></div>
        <a className="login" href="/dashboard">เข้าสู่ระบบ</a>
      </header>
      <section className="application-wrap">
        <div className="application-copy">
          <small>CREATOR APPLICATION</small><h1>สร้างรายได้จาก<br /><span>คอมมูนิตี้ของคุณ</span></h1>
          <p>Aurum Live ดูแลสมาชิก การต่ออายุ และการเข้าถึงคอนเทนต์ให้คุณ เพื่อให้คุณมีเวลาโฟกัสกับการสร้างผลงาน</p>
          <ul><li>✓ ระบบสมาชิกและวันหมดอายุอัตโนมัติ</li><li>✓ Live วิดีโอ กลุ่มแชต และไฟล์สมาชิก</li><li>✓ Dashboard รายได้และสมาชิกในที่เดียว</li><li>✓ Creator ทุกคนผ่านการตรวจสอบโดย Admin</li></ul>
        </div>
        <form className="application-card">
          <div className="step-row">{steps.map((step,i)=><span className={i===0?"current":""} key={step}><i>{i+1}</i><small>{step}</small></span>)}</div>
          <h2>เริ่มต้นสร้างบัญชี Creator</h2><p>กรอกข้อมูลเบื้องต้น ทีมงานจะตรวจสอบก่อนอนุญาตให้เปิดขาย</p>
          <label>ชื่อที่ใช้แสดง<input placeholder="ชื่อ Creator หรือชื่อแบรนด์" /></label>
          <label>อีเมลสำหรับติดต่อ<input type="email" placeholder="creator@example.com" /></label>
          <label>แพลตฟอร์มหลัก<select defaultValue=""><option value="" disabled>เลือกแพลตฟอร์ม</option><option>YouTube</option><option>TikTok</option><option>Facebook</option><option>Instagram</option><option>อื่น ๆ</option></select></label>
          <label>ลิงก์ช่องหรือโปรไฟล์<input placeholder="https://" /></label>
          <button type="button" className="button form-button">ดำเนินการต่อ <span>→</span></button>
          <small className="form-note">แบบฟอร์มนี้เป็นหน้าต้นแบบ ยังไม่มีการส่งข้อมูลจนกว่าจะเชื่อมฐานข้อมูล</small>
        </form>
      </section>
    </main>
  );
}
