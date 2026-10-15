# Worker พร็อกซี่ดิสคอร์ด — ที่ deploy ไว้แล้ว

โค้ดตัวเดียวกับ [`discord-proxy-worker.js`](discord-proxy-worker.js) แต่โฮสต์อยู่บนโฮสต์ของ Freebuff
(Cloudflare อยู่ข้างหลัง) — ใช้แทนการ deploy ขึ้นบัญชี Cloudflare เอง เมื่อติดปัญหาล็อกอิน

| อะไร | ค่า |
|---|---|
| Site ID | `3f9c1a72-8d54-4b0e-9c31-6a7e2d5b41c8` |
| Environment | `preview` |
| URL | `https://site-4429ace01a9f4280b63a94de8c1c421e.freebuff.page` |
| ชื่อความลับ | `PROXY_KEY` (ค่าอยู่ในไฟล์นอกโปรเจกต์: `C:\server\.secrets\proxy-key.txt`) |
| Manifest | [`deploy-manifest.json`](deploy-manifest.json) |

ค่าที่ต้องตั้งใน Render → mooni-relay → Environment:

```
DISCORD_API_BASE = https://site-4429ace01a9f4280b63a94de8c1c421e.freebuff.page/<ค่าในไฟล์ .secrets/proxy-key.txt>
```

## แก้โค้ดแล้ว deploy ใหม่

แก้ที่ `discord-proxy-worker.js` แล้ว deploy preview ซ้ำด้วย manifest เดิม (ใช้ siteId ข้างบน)
ถ้าเปลี่ยนโค้ดแล้วค่า `PROXY_KEY` ไม่เปลี่ยน สามารถ deploy ทับได้เลย ไม่ต้องตั้งความลับใหม่

## หมุนรหัส (ถ้าสงสัยว่ารหัสหลุด)

1. สุ่มรหัสใหม่ทับไฟล์ `.secrets/proxy-key.txt`
2. ตั้งความลับ `PROXY_KEY` ใหม่จากไฟล์นั้น แล้ว deploy อีกครั้ง
3. แก้ `DISCORD_API_BASE` ใน Render ให้ตรงกับรหัสใหม่ แล้ว Redeploy
4. ตรวจ `https://mooni-relay.onrender.com/health` → `customApiBase: true` และ `discord.status` ไม่ใช่ 429

## ตรวจว่า worker ยังทำงาน

```bash
bash relay/tools/verify-deployed-proxy.sh
```

ที่ต้องเห็น: `root`, `no-key`, `wrong-key` = 404 `not found` · `real-GET` = 200 `{"url":"wss://gateway.discord.gg"}`

## ย้ายกลับไปบัญชี Cloudflare ของตัวเอง (ตาม README)

โค้ดและรหัสชุดเดิมใช้ได้ทันที — deploy ขึ้น Cloudflare แล้วแก้ `DISCORD_API_BASE`
เป็น `https://<ชื่อ-worker>.workers.dev/<รหัส>` วิธีมีอยู่ในหัวไฟล์ `discord-proxy-worker.js`
