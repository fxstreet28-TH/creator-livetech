const creators = [
  { name: "Mild Studio", topic: "คุยเรื่องคอนเทนต์", color: "#ff74b8", viewers: "1.6K" },
  { name: "Krit Creator", topic: "เทคนิคถ่ายวิดีโอ", color: "#33d8ff", viewers: "987" },
  { name: "Praew Daily", topic: "ไลฟ์สไตล์ & รีวิว", color: "#a879ff", viewers: "1.2K" },
];

const features = [
  { icon: "◉", title: "ไลฟ์คมชัดทุกแพลตฟอร์ม", text: "ออกอากาศพร้อมกันหลายช่องทาง ภาพลื่นไหลและจัดการง่ายในหน้าจอเดียว" },
  { icon: "↗", title: "เข้าใจคนดูแบบเรียลไทม์", text: "ดูยอดผู้ชม การมีส่วนร่วม และช่วงเวลาที่ทำผลงานดีที่สุดได้ทันที" },
  { icon: "✦", title: "สร้างรายได้อย่างเป็นระบบ", text: "รวมรายได้ แคมเปญ และผู้สนับสนุนไว้ในแดชบอร์ดที่อ่านง่าย" },
];

function Logo() {
  return <span className="brand"><img src="/aurum-live-logo.png" alt="Aurum Live" /></span>;
}

function MiniAvatar({ color, label }: { color: string; label: string }) {
  return <span className="avatar" style={{ background: `linear-gradient(145deg, ${color}, #17182d)` }}>{label.slice(0, 1)}</span>;
}

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a href="#top" aria-label="Aurum Live หน้าหลัก"><Logo /></a>
        <nav aria-label="เมนูหลัก">
          <a className="active" href="#top">หน้าแรก</a><a href="#features">สำหรับครีเอเตอร์</a><a href="#features">ฟีเจอร์</a><a href="#income">รายได้</a><a href="#contact">ช่วยเหลือ</a>
        </nav>
        <div className="header-actions"><a className="login" href="/dashboard">เข้าสู่ระบบ</a><a className="button small" href="/signup">สมัครสมาชิก <span>→</span></a></div>
      </header>

      <section className="hero" id="top">
        <div className="hero-glow one" /><div className="hero-glow two" />
        <div className="hero-copy">
          <div className="eyebrow"><span /> แพลตฟอร์มไลฟ์สำหรับครีเอเตอร์ยุคใหม่</div>
          <h1>เปลี่ยนทุกไลฟ์<br />ให้เป็น<span>พลัง</span><br />สร้างแบรนด์</h1>
          <p>เปลี่ยนผู้ติดตามให้เป็นสมาชิกประจำ<br />พร้อมจัดการ Subscription ได้ในที่เดียว</p>
          <div className="hero-actions"><a className="button" href="/creator/apply">สร้างพื้นที่ของคุณ <span>→</span></a><a className="ghost-button" href="/explore">ค้นหา Creator <i>⌕</i></a></div>
          <div className="trust-row"><span>ϟ ตั้งค่าไว</span><b>•</b><span>▣ เครื่องมือครบ</span><b>•</b><span>♢ ดูแลตลอด 24 ชม.</span></div>
        </div>

        <div className="dashboard-shell" id="demo">
          <aside className="dash-sidebar"><img className="dash-logo" src="/aurum-live-logo.png" alt="Aurum Live" /><a className="selected">◉<small>สตรีม</small></a><a>▦<small>แดชบอร์ด</small></a><a>♙<small>คอมมูนิตี้</small></a><a>●<small>รายได้</small></a><a>⚙<small>ตั้งค่า</small></a></aside>
          <div className="dashboard-main">
            <div className="live-card">
              <img src="/hero-creator.png" alt="ครีเอเตอร์กำลังจัดรายการไลฟ์ในสตูดิโอ" />
              <div className="live-top"><span className="live-badge">● LIVE</span><span className="viewer">◉ 2,842</span></div>
              <div className="stream-controls"><span>♪</span><span>▣</span><span>▤</span><span>♢</span><button>จบไลฟ์</button></div>
            </div>
            <div className="dashboard-bottom">
              <div className="metric-card"><small>รายได้จากช่องวันนี้</small><strong>฿24,780</strong><span className="positive">▲ 18.6%</span><div className="bars">{[38,62,44,72,52,84,65,90].map((h,i)=><i key={i} style={{height:`${h}%`}} />)}</div></div>
              <div className="metric-card goal"><small>เป้าหมายรายได้</small><strong>฿18,540 <em>/ ฿30,000</em></strong><div className="progress"><i /></div><b>62%</b></div>
            </div>
          </div>
          <aside className="dash-right">
            <div className="chat-panel"><div className="panel-title">แชตสด <span>♟ 2.8K</span></div>{creators.map((c,i)=><div className="chat" key={c.name}><MiniAvatar color={c.color} label={c.name}/><p><b>{c.name}</b><small>{i === 0 ? "สวัสดีครับ วันนี้มีเทคนิคดีๆ กันแน่นอน!" : i === 1 ? "ชอบมากเลยครับ 🔥" : "มีความสุขกับทุกไลฟ์ 💜"}</small></p><time>20:3{i+1}</time></div>)}<div className="chat-input">พิมพ์ข้อความ... <span>➤</span></div></div>
            <div className="chart-panel"><div className="panel-title">ภาพรวมไลฟ์ <span>วันนี้⌄</span></div><div className="line-chart"><i/><b/><em/><span/></div><div className="chart-stats"><p><small>ผู้ชมพร้อมกัน</small><b>2,842</b></p><p><small>ยอดไลก์</small><b>12.6K</b></p><p><small>แชร์</small><b>1,254</b></p></div></div>
          </aside>
        </div>

        <div className="hero-stats"><div><i>♟</i><p><strong>12K+</strong><span>ครีเอเตอร์</span></p></div><div><i>▶</i><p><strong>3.2M</strong><span>ชั่วโมงรับชม</span></p></div><div><i>♢</i><p><strong>99.9%</strong><span>เสถียร</span></p></div></div>
      </section>

      <section className="logos" aria-label="ประเภทครีเอเตอร์"><span>ห้อง Live สมาชิก</span><span>วิดีโอพิเศษ</span><span>กลุ่มแชต</span><span>ไฟล์และคอร์ส</span><span>ต่ออายุอัตโนมัติ</span></section>

      <section className="features section" id="features">
        <div className="section-heading"><div><small>CREATOR-FIRST PLATFORM</small><h2>ทุกเครื่องมือที่ทำให้<br />ไลฟ์ของคุณ<span>ไปได้ไกลกว่า</span></h2></div><p>ไม่ว่าคุณเพิ่งเริ่มต้นหรือมีผู้ติดตามหลักล้าน AURUM LIVE ช่วยให้คุณจัดรายการ เติบโต และเข้าใจคนดูได้ง่ายขึ้น</p></div>
        <div className="feature-grid">{features.map((f,i)=><article key={f.title}><i>{f.icon}</i><small>0{i+1}</small><h3>{f.title}</h3><p>{f.text}</p><a href="#start">ดูรายละเอียด →</a></article>)}</div>
      </section>

      <section className="income section" id="income">
        <div className="income-card"><div className="income-copy"><small>REAL GROWTH. CLEAR DATA.</small><h2>เห็นทุกการเติบโต<br /><span>ชัดเจนในหน้าจอเดียว</span></h2><p>ตัดสินใจจากข้อมูลจริง พร้อมภาพรวมรายได้ ผู้ชม และประสิทธิภาพของทุกไลฟ์</p><ul><li>✓ รายงานรายได้และแคมเปญแบบเรียลไทม์</li><li>✓ วิเคราะห์พฤติกรรมและการมีส่วนร่วม</li><li>✓ ส่งออกรายงานสำหรับทีมและพาร์ตเนอร์</li></ul></div><div className="analytics"><div className="analytics-top"><p><small>รายได้เดือนนี้</small><strong>฿128,450</strong></p><span>+24.8% ↗</span></div><div className="big-chart">{[32,48,42,66,58,78,70,94,84,100,92,112].map((h,i)=><i key={i} style={{height:`${h}px`}} />)}</div><div className="analytics-row"><div><small>ผู้ติดตามใหม่</small><b>+4,892</b></div><div><small>เวลาเฉลี่ย</small><b>42:18</b></div><div><small>Engagement</small><b>18.4%</b></div></div></div></div>
      </section>

      <section className="cta section" id="start"><small>พร้อมเปลี่ยนทุกไลฟ์ให้มีพลังแล้วหรือยัง?</small><h2>เริ่มสร้างพื้นที่ของคุณ<br /><span>ให้โลกจดจำ</span></h2><p>เปิดช่องได้ฟรี ทดลองทุกฟีเจอร์ และเริ่มไลฟ์แรกภายในไม่กี่นาที</p><a className="button" href="mailto:hello@aurumlive.example">เริ่มต้นกับ AURUM LIVE <span>→</span></a></section>

      <footer id="contact"><Logo/><p>แพลตฟอร์มไลฟ์ครบวงจรสำหรับครีเอเตอร์ยุคใหม่</p><div><a href="#features">ฟีเจอร์</a><a href="#income">รายได้</a><a href="mailto:hello@aurumlive.example">ติดต่อเรา</a></div><small>© 2026 AURUM LIVE. Concept website.</small></footer>
    </main>
  );
}
