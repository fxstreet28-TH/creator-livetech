const creators = [
  { name: "Mild Studio", category: "คอนเทนต์และไลฟ์สไตล์", members: "1,240", price: "฿299/เดือน", accent: "#ff74b8" },
  { name: "Krit Creator", category: "วิดีโอและการสร้างแบรนด์", members: "860", price: "฿390/เดือน", accent: "#33d8ff" },
  { name: "Praew Daily", category: "รีวิวและคอมมูนิตี้", members: "2,100", price: "฿199/เดือน", accent: "#a879ff" },
];

export default function ExplorePage() {
  return (
    <main className="portal-page">
      <header className="portal-nav">
        <a href="/"><img src="/aurum-live-logo.png" alt="Aurum Live" /></a>
        <div><a className="active" href="/explore">ค้นหา Creator</a><a href="/creator/apply">สมัครเป็น Creator</a><a href="/dashboard">แดชบอร์ด</a></div>
        <a className="button small" href="/dashboard">เข้าสู่ระบบ</a>
      </header>
      <section className="portal-hero">
        <small>DISCOVER YOUR COMMUNITY</small>
        <h1>ค้นหาพื้นที่สมาชิก<br /><span>ที่เหมาะกับคุณ</span></h1>
        <p>สมัครครั้งเดียว เข้าถึง Live วิดีโอ กลุ่มพูดคุย และไฟล์พิเศษจาก Creator ที่คุณชื่นชอบ</p>
        <div className="search-box">⌕ <span>ค้นหาชื่อ Creator หรือหมวดหมู่...</span><button>ค้นหา</button></div>
      </section>
      <section className="creator-section">
        <div className="filter-row"><b>Creator แนะนำ</b><div><button className="selected">ทั้งหมด</button><button>ไลฟ์สไตล์</button><button>ความรู้</button><button>ครีเอทีฟ</button></div></div>
        <div className="creator-grid">
          {creators.map((creator, index) => (
            <article className="creator-card" key={creator.name}>
              <div className="creator-cover" style={{background:`radial-gradient(circle at 70% 35%, ${creator.accent}88, transparent 32%), linear-gradient(145deg,#171b31,#080a12)`}}>
                <span className="verified">✓ ตรวจสอบแล้ว</span><i>{creator.name.slice(0,1)}</i>
              </div>
              <div className="creator-info"><small>{creator.category}</small><h2>{creator.name}</h2><p>Live ทุกสัปดาห์ พร้อมเนื้อหาพิเศษและกลุ่มสมาชิกส่วนตัว</p><div><span>สมาชิก {creator.members} คน</span><strong>{creator.price}</strong></div><a href="/dashboard">ดูแพ็กเกจ →</a></div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
