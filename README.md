# AURUM LIVE

Landing page ของ **AURUM LIVE** — แพลตฟอร์มไลฟ์สตรีมมิงสำหรับครีเอเตอร์ยุคใหม่
(สร้างชุมชน จัดการสมาชิก และเปลี่ยนผู้ติดตามให้เป็นรายได้)

สร้างด้วย [Next.js](https://nextjs.org) (App Router) + React 19 + Tailwind CSS 4

## โครงสร้างโปรเจกต์

```
app/
  layout.tsx            # Root layout + metadata (ภาษาไทย)
  globals.css           # สไตล์ทั้งหมดของเว็บไซต์
  page.tsx              # หน้า Landing หลัก
  explore/page.tsx      # หน้าค้นหา Creator (ตัวอย่าง)
  creator/apply/page.tsx# หน้าสมัครเป็น Creator (ตัวอย่าง)
  dashboard/page.tsx    # หน้าแดชบอร์ด Creator (ตัวอย่าง)
public/
  aurum-live-logo.png   # โลโก้
  hero-creator.png      # รูปฮีโร่
```

> หน้า `explore`, `creator/apply`, และ `dashboard` เป็นหน้าต้นแบบ (static demo)
> ยังไม่มีการเชื่อมต่อฐานข้อมูลหรือระบบยืนยันตัวตน

## เริ่มต้นใช้งาน

```bash
npm install
npm run dev      # เปิด http://localhost:3000
```

## คำสั่งที่ใช้ได้

| คำสั่ง | รายละเอียด |
| --- | --- |
| `npm run dev` | รัน development server |
| `npm run build` | Build สำหรับ production |
| `npm run start` | รันเวอร์ชัน production ที่ build แล้ว |
| `npm run lint` | ตรวจโค้ดด้วย ESLint |

## Roadmap (แผนพัฒนาถัดไป)

ระบบสมาชิก (signup + login + OTP ทาง Email และ SMS) จะถูกพัฒนาต่อ **ทีละ PR**
ดูรายละเอียดใน Pull Request ที่แนะนำ roadmap
