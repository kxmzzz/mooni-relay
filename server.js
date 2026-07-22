/**
 * Mooni Relay — เซิร์ฟเวอร์กลางสำหรับกระจาย "ประกาศจากแอดมิน" ไปทุกเครื่องที่มีแอป
 *
 * ทุกแอป Mooni จะเชื่อม WebSocket มาที่นี่
 * แอดมินเปิดหน้าเว็บนี้ ใส่รหัส + ข้อความ กดส่ง → กระจายให้ทุกเครื่องพร้อมกัน
 *
 * ตั้งค่าผ่าน environment variable:
 *   PORT       — พอร์ต (โฮสต์ฟรีตั้งให้เอง)
 *   ADMIN_KEY  — รหัสสำหรับส่งประกาศ (ตั้งเองตอน deploy)
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'mooni';   // เปลี่ยนตอน deploy!

/* ==================================================================
 * ล็อกอิน Discord + เช็คยศ "Mooni" (Discord role gate)
 * ตั้งค่าผ่าน environment variable บน Render:
 *   DISCORD_CLIENT_ID      — Application → OAuth2 → Client ID
 *   DISCORD_CLIENT_SECRET  — Application → OAuth2 → Client Secret
 *   DISCORD_GUILD_ID       — ไอดีเซิร์ฟเวอร์ (เปิด Developer Mode แล้วคลิกขวาที่ชื่อเซิร์ฟเวอร์)
 *   DISCORD_ROLE_ID        — ไอดียศ Mooni (Server Settings → Roles → คลิกขวายศ)
 *   DISCORD_INVITE         — ลิงก์ชวนเข้าเซิร์ฟเวอร์ (โชว์ในแอปตอนยังไม่มียศ)
 *   AUTH_SECRET            — คีย์สุ่มไว้เซ็นบัตรผ่าน (Render สุ่มให้ได้)
 * ถ้ายังไม่ตั้งครบ แอปจะเปิดใช้ได้ตามปกติ (ไม่ล็อก) จนกว่าจะตั้งครบ
 * ================================================================== */
const D = {
  clientId: process.env.DISCORD_CLIENT_ID || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  guildId: process.env.DISCORD_GUILD_ID || '',
  roleId: process.env.DISCORD_ROLE_ID || '',
  invite: process.env.DISCORD_INVITE || '',
};
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(24).toString('hex');
const SESSION_DAYS = 3;   // บัตรผ่านหมดอายุแล้วต้องล็อกอินใหม่ (เช็คยศซ้ำ) ทุกกี่วัน
const AUTH_ENABLED = !!(D.clientId && D.clientSecret && D.guildId && D.roleId);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;

// เก็บผลล็อกอินชั่วคราว โยงด้วย pair ที่แอปสุ่มมา (แอปคอยถาม /auth/status)
const authResults = new Map();   // pair -> { status, reason, name, uid, token, exp, at }

// ล้างของเก่าทุก 5 นาที กันหน่วยความจำบวม
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authResults) if (now - v.at > 10 * 60 * 1000) authResults.delete(k);
}, 5 * 60 * 1000).unref?.();

/** เซ็นบัตรผ่าน (แอปเก็บไว้ ใช้ยืนยันว่าเคยผ่านยศแล้ว จนกว่าจะหมดอายุ) */
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifySession(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

/** หน้าเว็บเล็ก ๆ ที่ขึ้นหลังล็อกอินเสร็จ (บอกให้กลับไปที่แอป) */
function resultPage(ok, title, detail) {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Mooni</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;
justify-content:center;padding:20px;font-family:system-ui,'Segoe UI','Noto Sans Thai',sans-serif;color:#fdeef5;
background:radial-gradient(700px 400px at 50% -10%,rgba(255,122,184,.14),transparent 60%),#0a0a0c;text-align:center}
.card{max-width:420px;padding:30px;background:#17141b;border:2px solid #3a2030;box-shadow:6px 6px 0 #000}
.icon{font-size:46px;margin-bottom:10px}h1{font-size:20px;color:${ok ? '#7ee0a6' : '#ff5a6a'};margin-bottom:10px}
p{font-size:14px;color:#b58aa0;line-height:1.6}</style></head><body><div class="card">
<div class="icon">${ok ? '✅' : '🔒'}</div><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

/** เรียก Discord API ตรวจว่าคนที่ล็อกอินมียศ Mooni ในเซิร์ฟเวอร์ไหม */
async function checkDiscordMember(accessToken) {
  // ดึง member ของ user เองในเซิร์ฟเวอร์ที่กำหนด — ได้ทั้ง roles และชื่อในครั้งเดียว
  const r = await fetch(`https://discord.com/api/users/@me/guilds/${D.guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (r.status === 404) return { ok: false, reason: 'not_member' };   // ยังไม่ได้เข้าเซิร์ฟเวอร์
  if (!r.ok) return { ok: false, reason: 'api_error' };
  const m = await r.json();
  const name = m.nick || m.user?.global_name || m.user?.username || 'สมาชิก';
  const uid = m.user?.id || '';
  // รูปโปรไฟล์: ใช้รูปในเซิร์ฟเวอร์ก่อน ถ้าไม่มีก็รูป global ถ้าไม่มีอีกก็ปล่อยว่าง (แอปโชว์ตัวอักษรแทน)
  const avatar = m.avatar
    ? `https://cdn.discordapp.com/guilds/${D.guildId}/users/${uid}/avatars/${m.avatar}.png?size=64`
    : m.user?.avatar
    ? `https://cdn.discordapp.com/avatars/${uid}/${m.user.avatar}.png?size=64`
    : '';
  const hasRole = Array.isArray(m.roles) && m.roles.includes(D.roleId);
  return hasRole ? { ok: true, name, uid, avatar } : { ok: false, reason: 'no_role', name, uid };
}

/** จัดการทุก request ที่ขึ้นต้น /auth — คืน true ถ้าจัดการแล้ว */
async function handleAuth(req, res, url, cors) {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(obj));
  };

  // แอปถามว่าเปิดระบบล็อกอินหรือยัง (ตั้ง env ครบไหม)
  if (url.pathname === '/auth/config') {
    json(200, { enabled: AUTH_ENABLED, invite: D.invite });
    return true;
  }

  // เริ่มล็อกอิน — เด้งไป Discord
  if (url.pathname === '/auth/start') {
    if (!AUTH_ENABLED) { res.writeHead(503); res.end('auth not configured'); return true; }
    const pair = url.searchParams.get('pair') || '';
    if (!/^[a-f0-9]{8,64}$/.test(pair)) { res.writeHead(400); res.end('bad pair'); return true; }
    authResults.set(pair, { status: 'pending', at: Date.now() });
    const auth = new URL('https://discord.com/api/oauth2/authorize');
    auth.searchParams.set('client_id', D.clientId);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('redirect_uri', REDIRECT_URI);
    auth.searchParams.set('scope', 'identify guilds.members.read');
    auth.searchParams.set('state', pair);
    auth.searchParams.set('prompt', 'consent');
    res.writeHead(302, { Location: auth.toString() });
    res.end();
    return true;
  }

  // Discord เด้งกลับมาพร้อม code
  if (url.pathname === '/auth/callback') {
    const code = url.searchParams.get('code');
    const pair = url.searchParams.get('state') || '';
    const rec = authResults.get(pair);
    if (!code || !rec) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage(false, 'ลิงก์หมดอายุ', 'กรุณากดปุ่มล็อกอินในแอปใหม่อีกครั้ง'));
      return true;
    }
    try {
      const tokRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: D.clientId,
          client_secret: D.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
        }),
      });
      if (!tokRes.ok) throw new Error('token exchange failed');
      const tok = await tokRes.json();
      const check = await checkDiscordMember(tok.access_token);

      if (check.ok) {
        const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
        const token = signSession({ uid: check.uid, name: check.name, exp });
        authResults.set(pair, { status: 'ok', name: check.name, uid: check.uid, avatar: check.avatar || '', token, exp, at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultPage(true, `ยินดีต้อนรับ ${check.name}!`, 'ล็อกอินสำเร็จ กลับไปที่แอป Mooni ได้เลย — หน้าต่างนี้ปิดได้'));
      } else {
        const reasonText = check.reason === 'not_member'
          ? 'คุณยังไม่ได้เข้าเซิร์ฟเวอร์ Discord — กดลิงก์เข้าร่วมในแอปก่อน แล้วขอยศ Mooni'
          : 'บัญชี Discord ของคุณยังไม่มียศ "Mooni" — ทักแอดมินขอยศก่อนนะ';
        authResults.set(pair, { status: 'denied', reason: check.reason, name: check.name || '', at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultPage(false, 'ยังเข้าใช้ไม่ได้', reasonText));
      }
    } catch (e) {
      authResults.set(pair, { status: 'denied', reason: 'error', at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage(false, 'ล็อกอินไม่สำเร็จ', 'มีข้อผิดพลาดระหว่างเชื่อม Discord ลองใหม่อีกครั้ง'));
    }
    return true;
  }

  // แอปคอยถามผลล็อกอิน
  if (url.pathname === '/auth/status') {
    const pair = url.searchParams.get('pair') || '';
    const rec = authResults.get(pair);
    if (!rec) { json(200, { status: 'unknown' }); return true; }
    if (rec.status === 'ok') {
      json(200, { status: 'ok', name: rec.name, uid: rec.uid, avatar: rec.avatar || '', token: rec.token, exp: rec.exp });
      authResults.delete(pair);   // ใช้ครั้งเดียว
    } else if (rec.status === 'denied') {
      json(200, { status: 'denied', reason: rec.reason, name: rec.name });
      authResults.delete(pair);
    } else {
      json(200, { status: 'pending' });
    }
    return true;
  }

  return false;
}

const ADMIN_HTML = `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mooni — ส่งประกาศถึงทุกคน</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
    font-family:system-ui,'Segoe UI','Leelawadee UI','Noto Sans Thai',sans-serif;color:#fdeef5;
    background:radial-gradient(700px 400px at 50% -10%,rgba(255,122,184,.14),transparent 60%),#0a0a0c}
  .card{width:100%;max-width:460px;padding:26px;background:#17141b;border:2px solid #3a2030;box-shadow:6px 6px 0 #000}
  h1{font-size:19px;font-weight:800;margin-bottom:4px;color:#ff7ab8}
  p.sub{font-size:13px;color:#b58aa0;margin-bottom:18px}
  label{display:block;font-size:12.5px;font-weight:600;color:#b58aa0;margin:14px 0 8px}
  input,textarea{width:100%;padding:12px 14px;background:#0a0a0c;color:#fdeef5;border:2px solid #3a2030;font:inherit;font-size:15px}
  textarea{min-height:96px;resize:vertical}
  input:focus,textarea:focus{outline:none;border-color:#ff7ab8}
  .count{text-align:right;font-size:11.5px;color:#b58aa0;margin-top:6px}
  button{width:100%;margin-top:16px;padding:14px;background:linear-gradient(100deg,#d64f92,#ff7ab8);
    color:#2a0f1c;border:2px solid #000;box-shadow:3px 3px 0 #000;font:inherit;font-size:16px;font-weight:800;cursor:pointer;
    transition:transform .08s,box-shadow .08s}
  button:hover{transform:translate(-2px,-2px);box-shadow:5px 5px 0 #000}
  button:active{transform:translate(2px,2px);box-shadow:0 0 0 #000}
  button:disabled{opacity:.5;cursor:default}
  .status{margin-top:14px;font-size:13px;text-align:center;min-height:20px}
  .status.ok{color:#ff7ab8}.status.err{color:#ff5a6a}
  .online{margin-top:10px;font-size:12px;color:#b58aa0;text-align:center}
</style></head><body>
<div class="card">
  <h1>📢 ส่งประกาศถึงทุกคน</h1>
  <p class="sub">ข้อความจะขึ้นเป็นแถบเลื่อนที่แอป Mooni ของทุกคนที่เปิดอยู่</p>
  <label for="key">รหัสแอดมิน</label>
  <input id="key" type="password" placeholder="รหัสที่ตั้งไว้ตอน deploy" autocomplete="current-password">
  <label for="msg">ข้อความประกาศ</label>
  <textarea id="msg" maxlength="300" placeholder="เช่น เดี๋ยวแจกของขวัญพิเศษตอน 2 ทุ่มนะคะ 🎁"></textarea>
  <div class="count"><span id="count">0</span> / 300</div>
  <button id="send">ส่งประกาศ</button>
  <div class="status" id="status"></div>
  <div class="online" id="online"></div>
</div>
<script>
  const key=document.getElementById('key'),msg=document.getElementById('msg'),
        btn=document.getElementById('send'),status=document.getElementById('status'),
        count=document.getElementById('count'),online=document.getElementById('online');
  // จำรหัสไว้ไม่ต้องพิมพ์ใหม่
  key.value=localStorage.getItem('mooniKey')||'';
  msg.addEventListener('input',()=>count.textContent=msg.value.length);
  async function send(){
    const text=msg.value.trim(); if(!text){msg.focus();return;}
    localStorage.setItem('mooniKey',key.value);
    btn.disabled=true;status.className='status';status.textContent='กำลังส่ง…';
    try{
      const r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key:key.value,text})});
      const d=await r.json();
      if(!r.ok)throw new Error(d.error||'ส่งไม่สำเร็จ');
      status.className='status ok';status.textContent='✓ ส่งแล้ว';
      online.textContent='ถึงเครื่องที่เปิดอยู่ '+d.sentTo+' เครื่อง';
      msg.value='';count.textContent='0';
    }catch(e){status.className='status err';status.textContent='ส่งไม่ได้: '+e.message;}
    finally{btn.disabled=false;}
  }
  btn.addEventListener('click',send);
  msg.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')send();});
</script></body></html>`;

const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(ADMIN_HTML);
  }

  // เช็คสถานะ (โฮสต์บางที่ใช้ ping ให้ไม่หลับ)
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, clients: wss.clients.size, authEnabled: AUTH_ENABLED }));
  }

  // ล็อกอิน Discord / เช็คยศ
  if (req.method === 'GET' && url.pathname.startsWith('/auth/')) {
    handleAuth(req, res, url, cors).then((handled) => {
      if (!handled) { res.writeHead(404); res.end('not found'); }
    }).catch(() => { try { res.writeHead(500); res.end('error'); } catch {} });
    return;
  }

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch {}
      const headers = { 'Content-Type': 'application/json', ...cors };

      if (data.key !== ADMIN_KEY) {
        res.writeHead(401, headers);
        return res.end(JSON.stringify({ error: 'รหัสผ่านไม่ถูกต้อง' }));
      }
      const text = String(data.text || '').slice(0, 300).trim();
      if (!text) {
        res.writeHead(400, headers);
        return res.end(JSON.stringify({ error: 'ไม่มีข้อความ' }));
      }

      const sentTo = broadcast({ type: 'announce', text });
      console.log(`[relay] ส่งประกาศถึง ${sentTo} เครื่อง: ${text}`);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, sentTo }));
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log(`[relay] แอปเชื่อมเข้ามา (รวม ${wss.clients.size} เครื่อง)`);
  ws.on('close', () => console.log(`[relay] แอปหลุด (เหลือ ${wss.clients.size} เครื่อง)`));
  ws.on('error', () => {});
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  let n = 0;
  for (const client of wss.clients) {
    if (client.readyState === 1) { client.send(payload); n++; }
  }
  return n;
}

server.listen(PORT, () => {
  console.log(`Mooni Relay รันที่พอร์ต ${PORT}`);
  console.log(`ระบบล็อกอิน Discord: ${AUTH_ENABLED ? 'เปิด (เช็คยศ Mooni)' : 'ปิด — ยังตั้ง DISCORD_* ไม่ครบ'}`);
  if (AUTH_ENABLED) console.log(`Redirect URI ที่ต้องใส่ใน Discord: ${REDIRECT_URI}`);
});
