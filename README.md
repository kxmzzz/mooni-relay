# Mooni Relay — เซิร์ฟเวอร์กลางประกาศ

เอาไว้กระจาย "ประกาศจากแอดมิน" ให้ทุกเครื่องที่เปิดแอป Mooni พร้อมกัน

โฟลเดอร์นี้แยกออกจากตัวแอป — เอาไปวางบนโฮสต์ฟรีแล้วรันตลอด

---

## Deploy บน Render (ฟรี)

1. เอาโฟลเดอร์ `relay/` นี้ขึ้น GitHub (repo แยก หรือ subfolder ก็ได้)
2. เข้า https://render.com → **New → Web Service** → เชื่อม repo
3. ตั้งค่า:
   - **Root Directory:** `relay` (ถ้าอยู่ใน subfolder)
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment → Add:** `ADMIN_KEY` = รหัสลับที่คุณตั้งเอง (เช่น `mooni1234`)
4. กด Deploy รอสักครู่ จะได้ URL เช่น `https://mooni-relay.onrender.com`

## Deploy บน Railway (ฟรี)

1. https://railway.app → **New Project → Deploy from GitHub**
2. ชี้ไปโฟลเดอร์ `relay/`
3. Variables → เพิ่ม `ADMIN_KEY`
4. ได้ URL มาแบบเดียวกัน

---

## เอา URL ไปใส่ในแอป

1. เปลี่ยน `https://` เป็น `wss://` — เช่น `wss://mooni-relay.onrender.com`
2. เปิดไฟล์ `core/relay.js` ในตัวแอป ใส่ URL ตรง `DEFAULT_RELAY_URL`
3. `npm run build` ใหม่ แล้วแจกไฟล์ .exe — ทุกเครื่องจะเชื่อม relay อัตโนมัติ

หรือถ้าไม่อยาก build ใหม่ ใส่ URL ได้ที่หน้า **Setting → Announcement Relay** ในแอป

## ส่งประกาศ

เปิด `https://mooni-relay.onrender.com` (URL ตัว https) ในเบราว์เซอร์/มือถือ
ใส่ **รหัสแอดมิน** (ค่า `ADMIN_KEY`) + ข้อความ กดส่ง → ขึ้นทุกเครื่องที่เปิดแอปอยู่

---

## หมายเหตุ

- **Render ฟรีจะหลับหลังไม่มีคนใช้ ~15 นาที** ครั้งแรกที่ส่งอาจช้า ~30 วิ (ปลุกเซิร์ฟเวอร์)
  ถ้าอยากให้ไม่หลับ ใช้ตัวปิงฟรี (เช่น UptimeRobot) ยิง `GET /health` ทุก 5 นาที
- รหัสแอดมินกันคนอื่นแอบส่ง — ห้ามบอกใคร และควรตั้งให้เดายาก
- เซิร์ฟเวอร์นี้ไม่เก็บข้อมูลอะไร แค่ส่งต่อประกาศ
