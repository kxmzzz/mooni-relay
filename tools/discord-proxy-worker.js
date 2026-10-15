/**
 * ☁️ Cloudflare Worker — พร็อกซี่คำขอไปดิสคอร์ด
 *
 * ใช้เมื่อ IP ขาออกของโฮสต์ (Render) ถูกดิสคอร์ดแบนชั่วคราว
 * "You are being blocked from accessing our API temporarily due to exceeding global rate limits"
 * → ให้ relay ยิงคำขอผ่าน Worker นี้แทน (ออกจาก IP ของ Cloudflare) โดยไม่ต้องย้ายโฮสต์
 *
 * วิธีตั้ง (ฟรี ไม่ต้องใช้บัตรเครดิต ไม่ต้องมีโดเมน) ~5 นาที
 *  1. สมัคร/เข้า https://dash.cloudflare.com → เมนู Workers & Pages → Create → Workers → Get started
 *  2. ตั้งชื่อ เช่น `mooni-discord` → Deploy
 *  3. กด Edit code → ลบโค้ดเดิมทั้งหมด → วางโค้ดไฟล์นี้ทั้งไฟล์ → Deploy
 *  4. ตั้งรหัสกันคนอื่นใช้พร็อกซี่: Settings → Variables and Secrets → Add → ประเภท Secret
 *       Name: PROXY_KEY     Value: ตั้งรหัสยาว ๆ ของคุณเอง (เช่น mooni-9f3k2x)
 *     แล้ว Deploy ใหม่
 *  5. คัดลอก URL ที่ได้ เช่น https://mooni-discord.yourname.workers.dev
 *  6. เอาไปวางใน Render → mooni-relay → Environment → เพิ่มตัวแปร
 *       DISCORD_API_BASE = https://mooni-discord.yourname.workers.dev/mooni-9f3k2x
 *     (ต่อท้ายด้วยรหัสที่ตั้งในข้อ 4) แล้ว Redeploy
 *  7. เปิด https://mooni-relay.onrender.com/health ดูช่อง discord → ต้องไม่ใช่ 429 แล้ว
 *
 * หมายเหตุ: รหัส PROXY_KEY ต้องตรงกับท่อนท้าย URL ที่ตั้งใน DISCORD_API_BASE
 * ถ้ารหัสไม่ตรง Worker จะตอบ 404 (กันคนอื่นเอาไปใช้ฟรี)
 *
 * ── วิธี deploy ด้วยคำสั่ง (ไม่ต้องคลิกในหน้าเว็บ) ──
 * ถ้าหน้าล็อกอินของ Cloudflare มีปัญหา หรือขี้เกียจทำตาม 7 ข้อข้างบน ใช้วิธีนี้แทนได้:
 *
 *     cd relay/tools
 *     npx wrangler login                 # เปิดเบราว์เซอร์ กด Allow (ไม่ต้องพิมพ์รหัสผ่าน)
 *     npx wrangler deploy                # ใช้ wrangler.jsonc ในโฟลเดอร์นี้ → ได้ URL *.workers.dev
 *     npx wrangler secret put PROXY_KEY  # วางรหัสยาว ๆ ของคุณ แล้ว Enter
 *
 * ได้ URL กลับมาแบบ https://mooni-discord.<บัญชี>.workers.dev แล้วทำข้อ 6–7 ต่อ
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = String(env.PROXY_KEY || '');
    const prefix = '/' + key;

    // ต้องเข้าผ่าน /<รหัส>/... เท่านั้น
    if (!key || !url.pathname.startsWith(prefix + '/')) {
      return new Response('not found', { status: 404 });
    }

    // ตัดรหัสออก แล้วต่อกับดิสคอร์ดจริง — path ที่ relay ส่งมาจะเป็น /v10/... หรือ /oauth2/... อยู่แล้ว
    const target = 'https://discord.com/api' + url.pathname.slice(prefix.length) + url.search;

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');
    headers.delete('cf-ray');
    headers.delete('cf-visitor');
    headers.delete('x-forwarded-proto');
    headers.delete('x-real-ip');

    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

    return fetch(target, init);
  },
};
