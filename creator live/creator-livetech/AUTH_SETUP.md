# Creator LiveTech — ตั้งค่าระบบสมัครสมาชิก

ระบบสมัครสมาชิกใช้ Supabase Postgres, Resend และ Movider โดยผู้ใช้ต้องยืนยันทั้ง Email และเบอร์โทรก่อนสร้างบัญชีสำเร็จ

## 1. Supabase

1. สร้างโปรเจกต์ Supabase
2. เปิด SQL Editor
3. รันไฟล์ `supabase/migrations/001_signup.sql`
4. คัดลอก Project URL และ Secret key จากหน้า Connect / API Keys

## 2. Resend

1. เพิ่มและยืนยันโดเมนสำหรับส่ง Email
2. สร้าง API key
3. กำหนดผู้ส่ง เช่น `Creator LiveTech <otp@creatorlivetech.com>`

## 3. Vercel Environment Variables

เพิ่มค่าต่อไปนี้ใน Project Settings > Environment Variables โดยเลือก Production, Preview และ Development ตามความเหมาะสม

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `MOVIDER_API_KEY`
- `MOVIDER_API_SECRET`
- `MOVIDER_API_BASE_URL` (ใช้ค่าใน `.env.example` หาก Movider ไม่ได้แจ้ง URL อื่น)
- `OTP_PEPPER` (ข้อความสุ่มยาวอย่างน้อย 32 ตัวอักษร)

อย่าใส่ค่าจริงใน `.env.example` และอย่าอัปโหลด Secret key เข้า Git

## 4. ทดสอบ

เปิด `/signup` แล้วทดสอบตามลำดับ: สมัคร > Email OTP > SMS OTP > สร้างบัญชี จากนั้นตรวจตาราง `user_accounts` ใน Supabase

ระบบกำหนด OTP อายุ 5 นาที และกรอกรหัสผิดได้ไม่เกิน 5 ครั้ง รหัสผ่านถูกแฮชด้วย bcrypt และ Email OTP ถูกเก็บเป็น HMAC hash เท่านั้น
