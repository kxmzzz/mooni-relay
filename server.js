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
  primeRoleId: process.env.DISCORD_PRIME_ROLE_ID || '',   // ยศ Mooni Prime (ปลดล็อก Overlay/Win/Sound)
  botToken: process.env.DISCORD_BOT_TOKEN || '',          // โทเคนบอท — ใช้เช็คยศสดแบบเรียลไทม์ (ถอดยศแล้วรู้ทันที)
  publicKey: process.env.DISCORD_PUBLIC_KEY || '',        // Public Key ของแอป — ใช้ตรวจลายเซ็นปุ่มกดจาก Discord
  invite: process.env.DISCORD_INVITE || '',
};
/* บอทตัวที่สอง "☁️Muffin" — ระบบ ticket (ถ้าไม่ตั้ง จะใช้บอท Mooni ตัวเดิมแทน) */
const M = {
  botToken: process.env.MUFFIN_BOT_TOKEN || '',
  publicKey: process.env.MUFFIN_PUBLIC_KEY || '',
};
const muffinToken = () => M.botToken || D.botToken;
const muffinKey = () => M.publicKey || D.publicKey;

const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(24).toString('hex');
const SESSION_DAYS = 3;   // บัตรผ่านหมดอายุแล้วต้องล็อกอินใหม่ (เช็คยศซ้ำ) ทุกกี่วัน
const AUTH_ENABLED = !!(D.clientId && D.clientSecret && D.guildId && D.roleId);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;

/* ==================================================================
 * เก็บ "วันหมดอายุของแต่ละคน" ถาวรที่ Upstash Redis (ฟรี)
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (ตั้งใน Render)
 * เก็บเป็น hash ก้อนเดียวชื่อ mooni:access  (uid -> {exp})
 *   exp = เวลาหมดอายุเป็น ms | 0 = ถาวร | ไม่มี record = ถาวร (ยังไม่จำกัดเวลา)
 * ================================================================== */
const UP = {
  url: (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, ''),
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
};
const STORE_ENABLED = !!(UP.url && UP.token);

async function upstash(cmd) {
  if (!STORE_ENABLED) return { error: 'no-store' };
  try {
    const r = await fetch(UP.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UP.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

async function getAccess(uid) {
  const d = await upstash(['HGET', 'mooni:access', uid]);
  if (!d.result) return null;
  try { return JSON.parse(d.result); } catch { return null; }
}

async function getAccessMap() {
  const d = await upstash(['HGETALL', 'mooni:access']);
  const arr = d.result || [];
  const map = {};
  for (let i = 0; i < arr.length; i += 2) {
    try { map[arr[i]] = JSON.parse(arr[i + 1]); } catch { /* ข้าม */ }
  }
  return map;
}

async function setAccess(uid, rec) { return upstash(['HSET', 'mooni:access', uid, JSON.stringify(rec)]); }
async function delAccess(uid) { return upstash(['HDEL', 'mooni:access', uid]); }

/** ยังไม่หมดอายุไหม (ไม่มี record / exp=0 = ถาวร) */
function accessActive(rec) {
  if (!rec || !rec.exp) return true;
  return rec.exp > Date.now();
}

/* ---------- บอทจัดการยศ + ดึงรายชื่อสมาชิก ---------- */

const dcApi = (path) => `https://discord.com/api/v10${path}`;
const botHeaders = () => ({ Authorization: `Bot ${D.botToken}`, 'Content-Type': 'application/json' });

async function botSetRole(uid, roleId, on) {
  if (!D.botToken || !roleId) return false;
  try {
    const r = await fetch(dcApi(`/guilds/${D.guildId}/members/${uid}/roles/${roleId}`), {
      method: on ? 'PUT' : 'DELETE',
      headers: botHeaders(),
    });
    return r.ok || r.status === 204;
  } catch { return false; }
}

function memberAvatar(m) {
  const uid = m.user?.id;
  if (m.avatar) return `https://cdn.discordapp.com/guilds/${D.guildId}/users/${uid}/avatars/${m.avatar}.png?size=64`;
  if (m.user?.avatar) return `https://cdn.discordapp.com/avatars/${uid}/${m.user.avatar}.png?size=64`;
  return '';
}

/** ดึงสมาชิกทั้งเซิร์ฟเวอร์ (ต้องเปิด Server Members Intent) */
async function botListMembers() {
  if (!D.botToken) return [];
  try {
    const r = await fetch(dcApi(`/guilds/${D.guildId}/members?limit=1000`), { headers: botHeaders() });
    if (!r.ok) return [];
    const arr = await r.json();
    return arr.filter((m) => !m.user?.bot).map((m) => ({
      uid: m.user.id,
      name: m.nick || m.user.global_name || m.user.username,
      avatar: memberAvatar(m),
      mooni: Array.isArray(m.roles) && m.roles.includes(D.roleId),
      prime: D.primeRoleId ? (Array.isArray(m.roles) && m.roles.includes(D.primeRoleId)) : false,
    }));
  } catch { return []; }
}

/* ---------- ปุ่มรับยศใน Discord (Interactions) ---------- */

/**
 * ตรวจลายเซ็น Ed25519 ที่ Discord ส่งมา — ถ้าไม่ตรงแปลว่าไม่ได้มาจาก Discord จริง
 * ใช้ crypto ในตัว Node ไม่ต้องลงไลบรารีเพิ่ม (ใส่ DER prefix ให้เป็น SPKI)
 */
function verifyDiscordSig(signature, timestamp, rawBody, pubKey) {
  if (!pubKey || !signature || !timestamp) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubKey, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}

/**
 * โพสต์ข้อความ + รูป + ปุ่มรับยศ ลงห้องที่กำหนด
 * รูปใส่ได้ 2 แบบ: อัปโหลดไฟล์ (imageData = base64) หรือใส่ลิงก์ (imageUrl)
 */
async function botPostRoleButton({ channelId, text, imageUrl, imageData, imageName, buttonLabel, roleId }) {
  const embed = { color: 0xff7ab8 };
  if (text) embed.description = String(text).slice(0, 4000);

  let fileBuf = null, fname = null;
  if (imageData) {
    fname = String(imageName || 'image.png').replace(/[^\w.\-]/g, '_');
    fileBuf = Buffer.from(imageData, 'base64');
    embed.image = { url: `attachment://${fname}` };
  } else if (imageUrl) {
    embed.image = { url: String(imageUrl) };
  }

  const payload = {
    embeds: [embed],
    components: [{
      type: 1,
      components: [{
        type: 2,              // ปุ่ม
        style: 1,             // สีน้ำเงิน (primary)
        label: String(buttonLabel || 'รับยศ').slice(0, 80),
        custom_id: `role:${roleId}`,
      }],
    }],
  };

  let r;
  if (fileBuf) {
    // อัปโหลดไฟล์ต้องส่งแบบ multipart (อย่าตั้ง Content-Type เอง ปล่อยให้ใส่ boundary ให้)
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify(payload));
    fd.append('files[0]', new Blob([fileBuf]), fname);
    r = await fetch(dcApi(`/channels/${channelId}/messages`), {
      method: 'POST', headers: { Authorization: `Bot ${D.botToken}` }, body: fd,
    });
  } else {
    r = await fetch(dcApi(`/channels/${channelId}/messages`), {
      method: 'POST', headers: botHeaders(), body: JSON.stringify(payload),
    });
  }

  if (r.ok) return { ok: true };
  let detail = '';
  try { detail = (await r.json())?.message || ''; } catch {}
  return { ok: false, status: r.status, detail };
}

/* ---------- ระบบ Ticket (บอท ☁️Muffin) ---------- */

const hdr = (token) => ({ Authorization: `Bot ${token}`, 'Content-Type': 'application/json' });

// สิทธิ์: VIEW_CHANNEL(1024) + SEND_MESSAGES(2048) + READ_MESSAGE_HISTORY(65536) + ATTACH_FILES(32768)
const TICKET_ALLOW = String(1024 + 2048 + 65536 + 32768);
const VIEW_ONLY = '1024';

/** แก้ข้อความตอบกลับที่ค้างไว้ (หลังตอบ deferred) — ใช้ interaction token ไม่ต้องใช้โทเคนบอท */
async function editOriginal(appId, itoken, content) {
  try {
    await fetch(`https://discord.com/api/v10/webhooks/${appId}/${itoken}/messages/@original`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    });
  } catch { /* ตอบไม่ได้ก็ปล่อย */ }
}

/** โพสต์ข้อความ + ปุ่มเปิด ticket ลงห้องแผงควบคุม */
async function postTicketPanel({ channelId, text, imageData, imageName, imageUrl, buttonLabel, staffRoleId, categoryId }) {
  const token = muffinToken();
  const embed = { color: 0x8ec9ff };
  if (text) embed.description = String(text).slice(0, 4000);

  let fileBuf = null, fname = null;
  if (imageData) {
    fname = String(imageName || 'image.png').replace(/[^\w.\-]/g, '_');
    fileBuf = Buffer.from(imageData, 'base64');
    embed.image = { url: `attachment://${fname}` };
  } else if (imageUrl) embed.image = { url: String(imageUrl) };

  const payload = {
    embeds: [embed],
    components: [{
      type: 1,
      components: [{
        type: 2, style: 1,
        label: String(buttonLabel || '🎫 เปิด Ticket').slice(0, 80),
        custom_id: `tk:o:${staffRoleId}:${categoryId}`,
      }],
    }],
  };

  let r;
  if (fileBuf) {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify(payload));
    fd.append('files[0]', new Blob([fileBuf]), fname);
    r = await fetch(dcApi(`/channels/${channelId}/messages`), {
      method: 'POST', headers: { Authorization: `Bot ${token}` }, body: fd,
    });
  } else {
    r = await fetch(dcApi(`/channels/${channelId}/messages`), {
      method: 'POST', headers: hdr(token), body: JSON.stringify(payload),
    });
  }
  if (r.ok) return { ok: true };
  let detail = ''; try { detail = (await r.json())?.message || ''; } catch {}
  return { ok: false, status: r.status, detail };
}

/** สร้างห้อง ticket ให้คนที่กดปุ่ม (ทำหลังตอบ deferred แล้ว) */
async function createTicket(body, staffRoleId, categoryId) {
  const token = muffinToken();
  const appId = body.application_id, itoken = body.token;
  const guildId = body.guild_id || D.guildId;
  const user = body.member?.user;
  const uid = user?.id;
  if (!uid) return editOriginal(appId, itoken, 'อ่านข้อมูลผู้ใช้ไม่ได้');

  const uname = String(user.username || 'user').toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 20) || 'user';

  // กันเปิดซ้ำ — หาห้องเดิมในหมวดนี้ที่ topic มีไอดีเขา
  try {
    const chs = await fetch(dcApi(`/guilds/${guildId}/channels`), { headers: hdr(token) }).then((r) => r.json());
    const dup = Array.isArray(chs) && chs.find((c) => c.parent_id === categoryId && String(c.topic || '').includes(`ticket:${uid}`));
    if (dup) return editOriginal(appId, itoken, `คุณมีห้องที่เปิดอยู่แล้ว → <#${dup.id}>`);
  } catch { /* หาไม่ได้ก็สร้างใหม่ไปเลย */ }

  const res = await fetch(dcApi(`/guilds/${guildId}/channels`), {
    method: 'POST', headers: hdr(token),
    body: JSON.stringify({
      name: `ticket-${uname}`,
      type: 0,
      parent_id: categoryId,
      topic: `ticket:${uid}`,
      permission_overwrites: [
        { id: guildId, type: 0, deny: VIEW_ONLY },            // ทุกคนมองไม่เห็น
        { id: uid, type: 1, allow: TICKET_ALLOW },            // คนเปิด
        { id: staffRoleId, type: 0, allow: TICKET_ALLOW },    // ทีมงาน
      ],
    }),
  });

  const ch = await res.json().catch(() => ({}));
  if (!ch?.id) {
    return editOriginal(appId, itoken,
      `เปิดห้องไม่สำเร็จ (${res.status}) ${ch?.message || ''} — เช็คสิทธิ์บอท Manage Channels/Manage Roles และไอดีหมวดหมู่`);
  }

  // ข้อความต้อนรับ + ปุ่มสำหรับทีมงาน
  await fetch(dcApi(`/channels/${ch.id}/messages`), {
    method: 'POST', headers: hdr(token),
    body: JSON.stringify({
      content: `<@${uid}> <@&${staffRoleId}>`,
      embeds: [{
        color: 0x8ec9ff,
        description: '📩 เปิด Ticket เรียบร้อย — พิมพ์เรื่องที่ต้องการได้เลย รอทีมงานสักครู่นะ\n\n*ปุ่มด้านล่างใช้ได้เฉพาะทีมงานเท่านั้น*',
      }],
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: '✅ สำเร็จ', custom_id: `tk:d:${staffRoleId}` },
          { type: 2, style: 4, label: '🔒 ปิดห้อง', custom_id: `tk:c:${staffRoleId}` },
        ],
      }],
    }),
  }).catch(() => {});

  return editOriginal(appId, itoken, `เปิดห้องให้แล้ว → <#${ch.id}>`);
}

// ใครกำลังใช้แอปอยู่ (แอปยิง /auth/recheck ทุก 30 วิ) uid -> เวลาเห็นล่าสุด
const lastSeen = new Map();
const ACTIVE_WINDOW = 90 * 1000;   // เห็นภายใน 90 วิ = กำลังใช้งานอยู่

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
  const roles = Array.isArray(m.roles) ? m.roles : [];
  const hasRole = roles.includes(D.roleId);
  // มียศ Prime ไหม (ถ้าแอดมินไม่ได้ตั้ง PRIME_ROLE_ID ไว้ ให้ถือว่าทุกคนที่ล็อกอินได้ = prime)
  const prime = D.primeRoleId ? roles.includes(D.primeRoleId) : true;
  return hasRole ? { ok: true, name, uid, avatar, prime } : { ok: false, reason: 'no_role', name, uid };
}

/** ใช้บอทเช็คยศปัจจุบันของสมาชิก (เรียลไทม์ — ถอดยศแล้วรู้เลย) */
async function botCheckMember(uid) {
  try {
    const r = await fetch(`https://discord.com/api/guilds/${D.guildId}/members/${uid}`, {
      headers: { Authorization: `Bot ${D.botToken}` },
    });
    if (r.status === 404) return { inGuild: false, mooni: false, prime: false };   // ออกจากเซิร์ฟเวอร์แล้ว
    if (!r.ok) return { error: true };
    const m = await r.json();
    const roles = Array.isArray(m.roles) ? m.roles : [];
    return {
      inGuild: true,
      mooni: roles.includes(D.roleId),
      prime: D.primeRoleId ? roles.includes(D.primeRoleId) : true,
      name: m.nick || m.user?.global_name || m.user?.username || '',
    };
  } catch { return { error: true }; }
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

      // เช็ควันหมดอายุจากคลัง (แอดมินตั้งไว้ในเว็บ) — หมดอายุแล้วเข้าไม่ได้แม้มียศ
      const accessRec = STORE_ENABLED ? await getAccess(check.uid) : null;
      if (check.ok && !accessActive(accessRec)) {
        authResults.set(pair, { status: 'denied', reason: 'expired', name: check.name || '', at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultPage(false, 'หมดอายุการใช้งาน', 'สิทธิ์การใช้งานของคุณหมดอายุแล้ว — ทักแอดมินเพื่อต่ออายุ'));
        return true;
      }

      if (check.ok) {
        const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
        const accessExp = accessRec?.exp || 0;
        const token = signSession({ uid: check.uid, name: check.name, prime: !!check.prime, exp });
        authResults.set(pair, { status: 'ok', name: check.name, uid: check.uid, avatar: check.avatar || '', prime: !!check.prime, accessExp, token, exp, at: Date.now() });
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

  // เช็คยศสดแบบเรียลไทม์ (แอปเรียกซ้ำเรื่อย ๆ) — ถอดยศ/หมดอายุแล้วรู้ทันที
  if (url.pathname === '/auth/recheck') {
    const uid = url.searchParams.get('uid') || '';
    const token = url.searchParams.get('token') || '';
    const payload = verifySession(token);
    if (!payload || payload.uid !== uid) { json(200, { valid: false, reason: 'session' }); return true; }

    lastSeen.set(uid, Date.now());   // นับว่ากำลังใช้งานอยู่

    const rec = STORE_ENABLED ? await getAccess(uid) : null;
    const timeOk = accessActive(rec);
    const accessExp = rec?.exp || 0;

    // ไม่ได้ตั้งบอท => เช็คยศสดไม่ได้ แต่ยังเช็ควันหมดอายุได้
    if (!D.botToken) {
      json(200, { valid: timeOk, prime: !!payload.prime, accessExp, reason: timeOk ? '' : 'expired', live: false });
      return true;
    }
    const chk = await botCheckMember(uid);
    if (chk.error) {   // Discord ล่ม อย่าเพิ่งเตะออก
      json(200, { valid: timeOk, prime: !!payload.prime, accessExp, reason: timeOk ? '' : 'expired', live: false });
      return true;
    }
    const valid = !!chk.mooni && timeOk;
    const reason = !chk.mooni ? 'no_role' : !timeOk ? 'expired' : '';
    json(200, { valid, prime: !!chk.prime, accessExp, name: chk.name, live: true, reason });
    return true;
  }

  // แอปคอยถามผลล็อกอิน
  if (url.pathname === '/auth/status') {
    const pair = url.searchParams.get('pair') || '';
    const rec = authResults.get(pair);
    if (!rec) { json(200, { status: 'unknown' }); return true; }
    if (rec.status === 'ok') {
      json(200, { status: 'ok', name: rec.name, uid: rec.uid, avatar: rec.avatar || '', prime: !!rec.prime, accessExp: rec.accessExp || 0, token: rec.token, exp: rec.exp });
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

/* ==================================================================
 * หน้าเว็บแอดมิน /panel — จัดการยศ + วันหมดอายุ + ดูใครใช้งานอยู่
 * ================================================================== */
const PANEL_HTML = `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mooni — จัดการสมาชิก</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;padding:18px;font-family:system-ui,'Segoe UI','Leelawadee UI','Noto Sans Thai',sans-serif;
    color:#fdeef5;background:radial-gradient(800px 400px at 50% -10%,rgba(255,122,184,.12),transparent 60%),#0a0a0c}
  .wrap{max-width:1000px;margin:0 auto}
  h1{font-size:20px;color:#ff7ab8;margin-bottom:3px}
  p.sub{font-size:12.5px;color:#b58aa0;margin-bottom:16px}
  .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  input,select{padding:9px 11px;background:#0a0a0c;color:#fdeef5;border:2px solid #3a2030;font:inherit;font-size:13px}
  input:focus,select:focus{outline:none;border-color:#ff7ab8}
  .btn{padding:9px 13px;background:#2a1420;color:#ffd7ea;border:2px solid #3a2030;cursor:pointer;font:inherit;font-size:12.5px;font-weight:700}
  .btn:hover{border-color:#ff7ab8}
  .btn.pink{background:linear-gradient(100deg,#d64f92,#ff7ab8);color:#2a0f1c;border-color:#000}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:#b58aa0;font-size:11px;padding:8px 8px;border-bottom:2px solid #3a2030;text-transform:uppercase;letter-spacing:.5px}
  td{padding:8px 8px;border-bottom:1px solid #221820;vertical-align:middle}
  tr:hover td{background:rgba(255,122,184,.04)}
  .who{display:flex;align-items:center;gap:8px}
  .face{width:30px;height:30px;border-radius:50%;background:#2a1420 center/cover;border:2px solid #3a2030;flex:none}
  .dot{width:9px;height:9px;border-radius:50%;background:#444;display:inline-block;margin-right:5px;vertical-align:middle}
  .dot.on{background:#57d97e;box-shadow:0 0 8px #57d97e}
  .tag{display:inline-block;padding:2px 7px;font-size:10.5px;font-weight:700;border:1px solid #3a2030;border-radius:3px;color:#b58aa0}
  .tag.y{color:#57d97e;border-color:#2f6b45}
  .tog{cursor:pointer;user-select:none}
  .exp{font-size:11.5px;color:#ffcf3d}.exp.perm{color:#7ab8ff}.exp.gone{color:#ff5a6a}
  .setrow{display:flex;gap:6px;align-items:center;margin-top:6px}
  .setrow select.dur{min-width:120px;padding:6px 9px;cursor:pointer;border-color:#4a2a3a}
  .setrow select.dur:hover{border-color:#ff7ab8}
  .mini{padding:6px 10px;font-size:11px}
  #login{max-width:340px;margin:60px auto;padding:26px;background:#17141b;border:2px solid #3a2030;box-shadow:6px 6px 0 #000}
  #login h1{margin-bottom:14px}
  #login input{width:100%;margin-bottom:10px}
  #login .btn{width:100%}
  .msg{font-size:12px;color:#ff5a6a;min-height:16px;margin:8px 0}
  .hidden{display:none}
  .count{font-size:12px;color:#b58aa0}
  .rb{margin-bottom:16px;background:#17141b;border:2px solid #3a2030;padding:12px 14px}
  .rb summary{cursor:pointer;font-size:13.5px;font-weight:700;color:#ff7ab8}
  .rb-body{margin-top:12px;display:flex;flex-direction:column;gap:10px}
  .rb-body label{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:#b58aa0;flex:1}
  .rb-body input,.rb-body textarea{width:100%;padding:8px 10px;background:#0a0a0c;color:#fdeef5;border:2px solid #3a2030;font:inherit;font-size:13px}
  .rb-body textarea{resize:vertical}
  .rb-row{display:flex;gap:10px;flex-wrap:wrap}
  .rb-body .btn{align-self:flex-start;padding:10px 16px}
</style></head><body>
<div id="login">
  <h1>🔑 เข้าหน้าจัดการ</h1>
  <input id="key" type="password" placeholder="รหัสแอดมิน (ADMIN_KEY)">
  <button class="btn pink" id="enter">เข้า</button>
  <div class="msg" id="lmsg"></div>
</div>
<div class="wrap hidden" id="panel">
  <h1>👥 จัดการสมาชิก Mooni</h1>
  <p class="sub">กดยศ Mooni / Prime และตั้งวันหมดอายุได้เลย · จุดเขียว = กำลังใช้งานอยู่</p>
  <div class="bar">
    <input id="search" placeholder="ค้นหาชื่อ…" style="flex:1;min-width:160px">
    <span class="count" id="count"></span>
    <button class="btn" id="refresh">รีเฟรช</button>
  </div>
  <div class="msg" id="pmsg"></div>

  <details class="rb">
    <summary>🎁 ส่งปุ่มรับยศเข้า Discord</summary>
    <div class="rb-body">
      <div class="rb-row">
        <label>ไอดีห้อง (คลิกขวาห้อง → Copy Channel ID)<input id="rbChannel" value="1529781693417001031"></label>
        <label>ไอดียศที่จะให้<input id="rbRole" value="1484626107721322747"></label>
      </div>
      <label>ข้อความด้านบน<textarea id="rbText" rows="3" placeholder="เช่น กดปุ่มด้านล่างเพื่อรับยศสมาชิก 🎉"></textarea></label>
      <div class="rb-row">
        <label>อัปโหลดรูปจากเครื่อง<input id="rbFile" type="file" accept="image/*"></label>
        <label>หรือใส่ลิงก์รูป<input id="rbImage" placeholder="https://..."></label>
        <label style="max-width:130px">ชื่อปุ่ม<input id="rbLabel" value="รับยศ"></label>
      </div>
      <button class="btn pink" id="rbSend">ส่งเข้าห้อง Discord</button>
      <div class="msg" id="rbMsg"></div>
    </div>
  </details>

  <details class="rb">
    <summary>🎫 ส่งปุ่มเปิด Ticket (บอท ☁️Muffin)</summary>
    <div class="rb-body">
      <div class="rb-row">
        <label>ไอดีห้องที่จะวางปุ่ม<input id="tkChannel" value="1484627407695511582"></label>
        <label>ไอดียศทีมงาน (กดปิด/สำเร็จได้)<input id="tkRole" value="1484626578943246518"></label>
      </div>
      <label>ไอดีหมวดหมู่ที่จะสร้างห้อง<input id="tkCat" value="1530270907116028086"></label>
      <label>ข้อความด้านบน<textarea id="tkText" rows="3" placeholder="เช่น มีปัญหาหรือต้องการติดต่อทีมงาน กดปุ่มด้านล่างได้เลย 🎫"></textarea></label>
      <div class="rb-row">
        <label>อัปโหลดรูปจากเครื่อง<input id="tkFile" type="file" accept="image/*"></label>
        <label>หรือใส่ลิงก์รูป<input id="tkImage" placeholder="https://..."></label>
        <label style="max-width:150px">ชื่อปุ่ม<input id="tkLabel" value="🎫 เปิด Ticket"></label>
      </div>
      <button class="btn pink" id="tkSend">ส่งเข้าห้อง Discord</button>
      <div class="msg" id="tkMsg"></div>
    </div>
  </details>

  <table><thead><tr>
    <th>สมาชิก</th><th>Mooni</th><th>Prime</th><th>หมดอายุ</th>
  </tr></thead><tbody id="rows"></tbody></table>
</div>
<script>
  const $=id=>document.getElementById(id);
  let KEY=localStorage.getItem('mooniKey')||'';
  let members=[];

  async function call(path,body){
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,...body})});
    if(r.status===401)throw new Error('รหัสไม่ถูก');
    if(!r.ok)throw new Error('ผิดพลาด '+r.status);
    return r.json();
  }
  function fmtExp(exp){
    if(!exp)return['ถาวร','perm'];
    const left=exp-Date.now();
    if(left<=0)return['หมดอายุ','gone'];
    const d=Math.floor(left/86400000),h=Math.floor(left%86400000/3600000),m=Math.floor(left%3600000/60000);
    if(d>0)return['เหลือ '+d+' วัน '+h+' ชม.',''];
    if(h>0)return['เหลือ '+h+' ชม. '+m+' นาที',''];
    return['เหลือ '+m+' นาที',''];
  }
  function render(){
    const q=$('search').value.trim().toLowerCase();
    const list=members.filter(m=>!q||m.name.toLowerCase().includes(q));
    $('count').textContent=list.length+' คน · ออนไลน์ '+members.filter(m=>m.active).length;
    $('rows').innerHTML=list.map(m=>{
      const[et,ec]=fmtExp(m.exp);
      return '<tr data-uid="'+m.uid+'">'+
        '<td><div class="who"><div class="face" style="background-image:url(\\''+(m.avatar||'')+'\\')"></div>'+
          '<div><span class="dot '+(m.active?'on':'')+'"></span>'+esc(m.name)+'</div></div></td>'+
        '<td><span class="tag tog '+(m.mooni?'y':'')+'" data-role="mooni">'+(m.mooni?'มี ✓':'ไม่มี')+'</span></td>'+
        '<td><span class="tag tog '+(m.prime?'y':'')+'" data-role="prime">'+(m.prime?'มี ✓':'ไม่มี')+'</span></td>'+
        '<td><div class="exp '+ec+'">'+et+'</div>'+
          '<div class="setrow"><select class="dur">'+
          '<option value="">＋ ตั้งเวลา…</option>'+
          '<option value="300000">5 นาที</option>'+
          '<option value="3600000">1 ชั่วโมง</option>'+
          '<option value="86400000">1 วัน</option>'+
          '<option value="604800000">7 วัน</option>'+
          '<option value="2592000000">30 วัน</option>'+
          '<option value="7776000000">90 วัน</option>'+
          '<option value="15552000000">6 เดือน</option>'+
          '<option value="31536000000">1 ปี</option>'+
          '<option value="perm">♾ ถาวร</option>'+
          '</select>'+
          '<button class="btn mini gone">หมดอายุ</button></div></td></tr>';
    }).join('');
  }
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

  async function load(){
    try{const d=await call('/panel/members',{});members=d.members||[];render();$('pmsg').textContent='';}
    catch(e){$('pmsg').textContent=e.message;}
  }
  $('rows').addEventListener('click',async e=>{
    const tr=e.target.closest('tr');if(!tr)return;const uid=tr.dataset.uid;
    try{
      if(e.target.classList.contains('tog')){
        const role=e.target.dataset.role,on=!e.target.classList.contains('y');
        e.target.textContent='...';await call('/panel/role',{uid,role,on});await load();
      }else if(e.target.classList.contains('gone')){await call('/panel/expiry',{uid,exp:Date.now()-1000});await load();}
    }catch(err){$('pmsg').textContent=err.message;}
  });
  // เลือกเวลาจากดรอปดาวน์เดียว แล้วตั้งเลยทันที
  $('rows').addEventListener('change',async e=>{
    if(!e.target.classList.contains('dur'))return;
    const tr=e.target.closest('tr');const uid=tr.dataset.uid,v=e.target.value;
    if(!v)return;
    try{await call('/panel/expiry',{uid,exp:v==='perm'?0:Date.now()+Number(v)});await load();}
    catch(err){$('pmsg').textContent=err.message;e.target.value='';}
  });
  // อ่านไฟล์รูปเป็น base64 (ใช้ร่วมกันทั้ง 2 ฟอร์ม)
  async function readImg(input){
    const f=input.files[0]; if(!f)return{};
    if(f.size>8*1024*1024)throw new Error('รูปใหญ่เกิน 8MB');
    const imageData=await new Promise((res,rej)=>{const fr=new FileReader();
      fr.onload=()=>res(String(fr.result).split(',')[1]);fr.onerror=()=>rej(new Error('อ่านไฟล์ไม่ได้'));
      fr.readAsDataURL(f);});
    return {imageData,imageName:f.name};
  }
  $('tkSend').addEventListener('click',async()=>{
    const b=$('tkSend');b.disabled=true;$('tkMsg').style.color='#b58aa0';$('tkMsg').textContent='กำลังส่ง…';
    try{
      const img=await readImg($('tkFile'));
      await call('/panel/ticketpanel',{channelId:$('tkChannel').value.trim(),staffRoleId:$('tkRole').value.trim(),
        categoryId:$('tkCat').value.trim(),text:$('tkText').value,imageUrl:$('tkImage').value.trim(),
        ...img,buttonLabel:$('tkLabel').value.trim()});
      $('tkMsg').style.color='#57d97e';$('tkMsg').textContent='✅ ส่งเข้าห้องแล้ว';
    }catch(e){$('tkMsg').style.color='#ff5a6a';$('tkMsg').textContent=e.message;}
    finally{b.disabled=false;}
  });
  $('search').addEventListener('input',render);
  $('refresh').addEventListener('click',load);
  $('rbSend').addEventListener('click',async()=>{
    const b=$('rbSend');b.disabled=true;$('rbMsg').style.color='#b58aa0';$('rbMsg').textContent='กำลังส่ง…';
    try{
      // มีไฟล์รูป -> อ่านเป็น base64 ส่งไปให้บอทแนบ
      let imageData=null,imageName=null;
      const f=$('rbFile').files[0];
      if(f){
        if(f.size>8*1024*1024)throw new Error('รูปใหญ่เกิน 8MB');
        imageName=f.name;
        imageData=await new Promise((res,rej)=>{const fr=new FileReader();
          fr.onload=()=>res(String(fr.result).split(',')[1]);fr.onerror=()=>rej(new Error('อ่านไฟล์ไม่ได้'));
          fr.readAsDataURL(f);});
      }
      await call('/panel/rolebutton',{channelId:$('rbChannel').value.trim(),roleId:$('rbRole').value.trim(),
        text:$('rbText').value,imageUrl:$('rbImage').value.trim(),imageData,imageName,
        buttonLabel:$('rbLabel').value.trim()});
      $('rbMsg').style.color='#57d97e';$('rbMsg').textContent='✅ ส่งเข้าห้องแล้ว';
    }catch(e){$('rbMsg').style.color='#ff5a6a';$('rbMsg').textContent=e.message;}
    finally{b.disabled=false;}
  });
  $('enter').addEventListener('click',async()=>{
    KEY=$('key').value.trim();localStorage.setItem('mooniKey',KEY);
    try{await call('/panel/members',{});$('login').classList.add('hidden');$('panel').classList.remove('hidden');load();setInterval(load,15000);}
    catch(e){$('lmsg').textContent=e.message;}
  });
  if(KEY){$('enter').click();}
</script></body></html>`;

/** อ่าน body ดิบเป็นข้อความ (ต้องใช้ตัวดิบตรวจลายเซ็น Discord) */
function readRaw(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

/**
 * Discord ยิงมาที่นี่ตอนมีคนกดปุ่ม (ตั้ง Interactions Endpoint URL ในหน้า Developer Portal)
 * ตอบกลับต้องไม่เกิน 3 วินาที
 */
async function handleInteraction(req, res, pubKey) {
  const raw = await readRaw(req);
  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];

  if (!verifyDiscordSig(sig, ts, raw, pubKey)) {
    res.writeHead(401); return res.end('invalid request signature');
  }

  let body = {};
  try { body = JSON.parse(raw); } catch {}
  const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const reply = (content) => json({ type: 4, data: { content, flags: 64 } });   // flags 64 = เห็นคนเดียว

  if (body.type === 1) return json({ type: 1 });          // PING ตอนตั้งค่า URL

  if (body.type === 3) {                                   // กดปุ่ม
    const customId = body.data?.custom_id || '';

    /* ---- ระบบ Ticket ---- */
    if (customId.startsWith('tk:o:')) {                     // เปิด ticket
      const [, , staffRoleId, categoryId] = customId.split(':');
      json({ type: 5, data: { flags: 64 } });               // ตอบ deferred ก่อน กันเกิน 3 วิ
      createTicket(body, staffRoleId, categoryId).catch(() => {});
      return;
    }

    if (customId.startsWith('tk:d:') || customId.startsWith('tk:c:')) {
      const staffRoleId = customId.split(':')[2];
      const roles = body.member?.roles || [];
      // คนเปิดห้อง (ไม่มียศทีมงาน) กดไม่ได้
      if (!roles.includes(staffRoleId)) return reply('❌ ปุ่มนี้ใช้ได้เฉพาะทีมงานเท่านั้น');

      const token = muffinToken();
      const chId = body.channel_id;

      if (customId.startsWith('tk:d:')) {                   // ✅ สำเร็จ
        const cur = body.channel?.name || '';
        if (cur && !cur.startsWith('✅')) {
          fetch(dcApi(`/channels/${chId}`), {
            method: 'PATCH', headers: hdr(token),
            body: JSON.stringify({ name: `✅-${cur}`.slice(0, 95) }),
          }).catch(() => {});
        }
        return json({ type: 4, data: { content: `✅ <@${body.member?.user?.id}> ทำเครื่องหมายว่า **สำเร็จ** แล้ว` } });
      }

      // 🔒 ปิดห้อง — ตอบก่อนแล้วค่อยลบ
      json({ type: 4, data: { content: '🔒 กำลังปิดห้องนี้ใน 3 วินาที…' } });
      setTimeout(() => {
        fetch(dcApi(`/channels/${chId}`), { method: 'DELETE', headers: hdr(token) }).catch(() => {});
      }, 3000);
      return;
    }

    if (!customId.startsWith('role:')) return reply('ปุ่มนี้ใช้ไม่ได้แล้ว');

    const roleId = customId.slice(5);
    const uid = body.member?.user?.id;
    if (!uid) return reply('อ่านข้อมูลผู้ใช้ไม่ได้');

    if ((body.member?.roles || []).includes(roleId)) return reply('✅ คุณมียศนี้อยู่แล้ว');

    const ok = await botSetRole(uid, roleId, true);
    return reply(ok
      ? '🎉 รับยศเรียบร้อยแล้ว!'
      : '❌ ให้ยศไม่สำเร็จ — บอทอาจไม่มีสิทธิ์ Manage Roles หรือยศบอทอยู่ต่ำกว่ายศนี้');
  }

  return json({ type: 4, data: { content: 'ไม่รองรับคำสั่งนี้', flags: 64 } });
}

/** อ่าน body เป็น JSON (จำกัดขนาดกันสแปม — เผื่อรูปอัปโหลดได้ถึง ~12MB) */
function readJson(req, max = 12 * 1024 * 1024) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > max) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/** จัดการ /panel/* (POST) — คืน {code, body} */
async function handlePanel(pathname, data) {
  if (data.key !== ADMIN_KEY) return { code: 401, body: { error: 'รหัสผ่านไม่ถูกต้อง' } };
  if (!D.botToken) return { code: 400, body: { error: 'ยังไม่ได้ตั้งบอท (DISCORD_BOT_TOKEN)' } };

  if (pathname === '/panel/members') {
    const [list, accessMap] = await Promise.all([botListMembers(), STORE_ENABLED ? getAccessMap() : {}]);
    const now = Date.now();
    const members = list.map((m) => ({
      ...m,
      exp: accessMap[m.uid]?.exp || 0,
      active: (now - (lastSeen.get(m.uid) || 0)) < ACTIVE_WINDOW,
    }));
    // เรียง: ออนไลน์ก่อน แล้วตามชื่อ
    members.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    return { code: 200, body: { members } };
  }

  if (pathname === '/panel/role') {
    const roleId = data.role === 'prime' ? D.primeRoleId : D.roleId;
    if (!roleId) return { code: 400, body: { error: 'ยังไม่ได้ตั้งไอดียศนี้' } };
    const ok = await botSetRole(String(data.uid), roleId, !!data.on);
    return { code: ok ? 200 : 500, body: ok ? { ok: true } : { error: 'บอทกดยศไม่สำเร็จ (เช็คสิทธิ์ Manage Roles + ลำดับยศ)' } };
  }

  if (pathname === '/panel/rolebutton') {
    const channelId = String(data.channelId || '').trim();
    const roleId = String(data.roleId || '').trim();
    if (!/^\d{5,}$/.test(channelId)) return { code: 400, body: { error: 'ไอดีห้องไม่ถูกต้อง' } };
    if (!/^\d{5,}$/.test(roleId)) return { code: 400, body: { error: 'ไอดียศไม่ถูกต้อง' } };
    const out = await botPostRoleButton({
      channelId, roleId,
      text: data.text, imageUrl: data.imageUrl,
      imageData: data.imageData, imageName: data.imageName,
      buttonLabel: data.buttonLabel,
    });
    return out.ok
      ? { code: 200, body: { ok: true } }
      : { code: 500, body: { error: `ส่งไม่สำเร็จ (${out.status}) ${out.detail || 'เช็คว่าบอทเห็นห้องนี้และมีสิทธิ์ส่งข้อความ'}` } };
  }

  if (pathname === '/panel/ticketpanel') {
    const channelId = String(data.channelId || '').trim();
    const staffRoleId = String(data.staffRoleId || '').trim();
    const categoryId = String(data.categoryId || '').trim();
    for (const [v, label] of [[channelId, 'ห้อง'], [staffRoleId, 'ยศทีมงาน'], [categoryId, 'หมวดหมู่']]) {
      if (!/^\d{5,}$/.test(v)) return { code: 400, body: { error: `ไอดี${label}ไม่ถูกต้อง` } };
    }
    const out = await postTicketPanel({
      channelId, staffRoleId, categoryId,
      text: data.text, imageUrl: data.imageUrl,
      imageData: data.imageData, imageName: data.imageName,
      buttonLabel: data.buttonLabel,
    });
    return out.ok
      ? { code: 200, body: { ok: true } }
      : { code: 500, body: { error: `ส่งไม่สำเร็จ (${out.status}) ${out.detail || 'เช็คว่าบอทเห็นห้องนี้และมีสิทธิ์ส่งข้อความ'}` } };
  }

  if (pathname === '/panel/expiry') {
    if (!STORE_ENABLED) return { code: 400, body: { error: 'ยังไม่ได้ตั้ง Upstash' } };
    const exp = Number(data.exp) || 0;
    if (exp === 0) await delAccess(String(data.uid));   // ถาวร = ไม่มี record
    else await setAccess(String(data.uid), { exp });
    return { code: 200, body: { ok: true } };
  }

  return { code: 404, body: { error: 'not found' } };
}

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
    return res.end(JSON.stringify({
      ok: true, clients: wss.clients.size, authEnabled: AUTH_ENABLED,
      bot: !!D.botToken, store: STORE_ENABLED,
      publicKey: !!D.publicKey, publicKeyLen: D.publicKey.length,
      muffinToken: !!M.botToken, muffinKey: !!M.publicKey, muffinKeyLen: M.publicKey.length,
    }));
  }

  // ทดสอบ Upstash ตรง ๆ (เขียน+อ่าน) — ไว้ debug ว่าคีย์ถูกไหม (ไม่โชว์ token)
  if (req.method === 'GET' && url.pathname === '/debug/store') {
    (async () => {
      const k = 'mooni:selftest';
      const w = await upstash(['SET', k, 'v-' + Date.now()]);
      const r = await upstash(['GET', k]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        storeEnabled: STORE_ENABLED,
        urlSet: !!UP.url, tokenSet: !!UP.token,
        urlHost: UP.url.replace(/^https?:\/\//, '').split('.')[0],
        writeResult: w, readResult: r,
      }));
    })().catch((e) => { try { res.writeHead(500); res.end(String(e.message)); } catch {} });
    return;
  }

  // ล็อกอิน Discord / เช็คยศ
  if (req.method === 'GET' && url.pathname.startsWith('/auth/')) {
    handleAuth(req, res, url, cors).then((handled) => {
      if (!handled) { res.writeHead(404); res.end('not found'); }
    }).catch(() => { try { res.writeHead(500); res.end('error'); } catch {} });
    return;
  }

  // Discord ยิงมาตอนมีคนกดปุ่ม (Interactions Endpoint)
  // /discord/interactions = บอท Mooni (ปุ่มรับยศ) · /discord/muffin = บอท ☁️Muffin (ticket)
  if (req.method === 'POST' && url.pathname === '/discord/interactions') {
    handleInteraction(req, res, D.publicKey).catch(() => { try { res.writeHead(500); res.end('error'); } catch {} });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/discord/muffin') {
    handleInteraction(req, res, muffinKey()).catch(() => { try { res.writeHead(500); res.end('error'); } catch {} });
    return;
  }

  // หน้าเว็บแอดมินจัดการสมาชิก
  if (req.method === 'GET' && url.pathname === '/panel') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PANEL_HTML);
  }
  if (req.method === 'POST' && url.pathname.startsWith('/panel/')) {
    readJson(req).then((data) => handlePanel(url.pathname, data)).then((out) => {
      res.writeHead(out.code, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(out.body));
    }).catch(() => { try { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'error' })); } catch {} });
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
  console.log(`บอทเช็คยศสด: ${D.botToken ? 'เปิด' : 'ปิด'} · คลังวันหมดอายุ (Upstash): ${STORE_ENABLED ? 'เปิด' : 'ปิด'}`);
  if (AUTH_ENABLED) console.log(`Redirect URI ที่ต้องใส่ใน Discord: ${REDIRECT_URI}`);
  console.log(`หน้าจัดการสมาชิก: ${PUBLIC_URL}/panel`);
});
