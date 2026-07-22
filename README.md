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

## ล็อกอิน Discord + ยศ "Mooni" (ล็อกไม่ให้คนไม่มียศเปิดแอป)

ให้แอปเปิดได้เฉพาะคนที่อยู่ในเซิร์ฟเวอร์ Discord และมียศ **Mooni**
ถ้ายังตั้งค่าไม่ครบ แอปจะเปิดใช้ได้ตามปกติ (ไม่ล็อก) — ล็อกก็ต่อเมื่อตั้ง env ครบทั้ง 4 ตัว

### 1. Discord Developer Portal — https://discord.com/developers/applications
- **New Application** → ตั้งชื่อ Mooni
- แท็บ **OAuth2** → คัดลอก **Client ID** และ **Client Secret** (กด Reset Secret เพื่อดู)
- **OAuth2 → Redirects → Add Redirect** ใส่:
  `https://mooni-relay.onrender.com/auth/callback`  แล้ว **Save**

### 2. เซิร์ฟเวอร์ Discord ของคุณ
- เปิด **Developer Mode**: User Settings → Advanced → Developer Mode (เปิด)
- **Server Settings → Roles → Create Role** ชื่อ `Mooni` แล้วแจกยศนี้ให้คนที่จะใช้แอป
- คลิกขวายศ Mooni → **Copy Role ID**  = `DISCORD_ROLE_ID`
- คลิกขวาไอคอนเซิร์ฟเวอร์ → **Copy Server ID**  = `DISCORD_GUILD_ID`

### 3. Render → mooni-relay → Environment → ใส่ตัวแปร
| Key | ค่า |
|-----|-----|
| `DISCORD_CLIENT_ID` | จากข้อ 1 |
| `DISCORD_CLIENT_SECRET` | จากข้อ 1 |
| `DISCORD_GUILD_ID` | จากข้อ 2 |
| `DISCORD_ROLE_ID` | จากข้อ 2 |
| `DISCORD_INVITE` | ลิงก์ชวนเข้าเซิร์ฟเวอร์ (เช่น https://discord.gg/xxxx) |
| `AUTH_SECRET` | สุ่มยาว ๆ (ถ้ายังไม่มี) |

ใส่ครบแล้ว Render จะ redeploy เอง → แอปทุกเครื่องจะเด้งหน้าล็อกอิน Discord

> คนใช้แอปกดปุ่ม "เข้าสู่ระบบด้วย Discord" → ล็อกอินในเบราว์เซอร์ → ถ้ามียศ Mooni ก็เข้าแอปได้
> บัตรผ่านจำไว้ 3 วัน แล้วต้องล็อกอินใหม่ (เช็คยศซ้ำ) — ถ้าถอดยศใครออก ภายใน 3 วันเขาจะหมดสิทธิ์

## หมายเหตุ

- **Render ฟรีจะหลับหลังไม่มีคนใช้ ~15 นาที** ครั้งแรกที่ส่งอาจช้า ~30 วิ (ปลุกเซิร์ฟเวอร์)
  ถ้าอยากให้ไม่หลับ ใช้ตัวปิงฟรี (เช่น UptimeRobot) ยิง `GET /health` ทุก 5 นาที
- รหัสแอดมินกันคนอื่นแอบส่ง — ห้ามบอกใคร และควรตั้งให้เดายาก
- เซิร์ฟเวอร์นี้ไม่เก็บข้อมูลอะไร แค่ส่งต่อประกาศ
