const benefits = ["ห้อง Live เฉพาะสมาชิก","วิดีโอและโพสต์พิเศษ","กลุ่มแชตสมาชิก","ไฟล์และคอร์สดาวน์โหลด"];

export default function DashboardPage() {
  return (
    <main className="portal-page dashboard-page">
      <aside className="portal-sidebar">
        <a href="/"><img src="/aurum-live-logo.png" alt="Aurum Live" /></a>
        <nav><a className="active">▦ ภาพรวม</a><a>♙ สมาชิก</a><a>▶ คอนเทนต์</a><a>◉ Live</a><a>● รายได้</a><a>⚙ ตั้งค่า</a></nav>
        <a href="/" className="back-home">← กลับหน้าเว็บไซต์</a>
      </aside>
      <section className="dashboard-content">
        <header><div><small>CREATOR DASHBOARD</small><h1>สวัสดี, Mild Studio</h1><p>ภาพรวมคอมมูนิตี้และรายได้ของคุณ</p></div><button className="button small">+ สร้างคอนเทนต์</button></header>
        <div className="status-banner"><div><i>✓</i><p><b>บัญชี Creator ได้รับการอนุมัติแล้ว</b><small>คุณสามารถสร้างแพ็กเกจและเปิดรับสมาชิกได้</small></p></div><span>VERIFIED CREATOR</span></div>
        <div className="summary-grid">
          <article><small>สมาชิก Active</small><strong>1,240</strong><em>+8.4% เดือนนี้</em></article>
          <article><small>รายได้เดือนนี้</small><strong>฿128,450</strong><em>+24.8% เดือนนี้</em></article>
          <article><small>ใกล้หมดอายุ</small><strong>48</strong><em className="warning">ภายใน 7 วัน</em></article>
          <article><small>รอชำระเงิน</small><strong>17</strong><em className="warning">อยู่ใน Grace period</em></article>
        </div>
        <div className="dashboard-columns">
          <article className="member-plan"><div className="card-heading"><div><small>แพ็กเกจหลัก</small><h2>Aurum Community</h2></div><strong>฿299<small>/เดือน</small></strong></div>
            <ul>{benefits.map(item=><li key={item}>✓ {item}</li>)}</ul><div className="plan-progress"><span><b>1,240</b> สมาชิก Active</span><span><b>92%</b> ต่ออายุ</span></div>
          </article>
          <article className="activity-card"><div className="card-heading"><div><small>กิจกรรมล่าสุด</small><h2>Subscription</h2></div><a>ดูทั้งหมด</a></div>
            {["Kanya ต่ออายุสมาชิกแล้ว","Napat สมัครแพ็กเกจใหม่","Pim กำลังอยู่ใน Grace period","Somchai ยกเลิกการต่ออายุ"].map((item,i)=><div className="activity" key={item}><i className={i===2?"pending":""}>{i===2?"!":"✓"}</i><p><b>{item}</b><small>{i+2} นาทีที่แล้ว</small></p></div>)}
          </article>
        </div>
      </section>
    </main>
  );
}
