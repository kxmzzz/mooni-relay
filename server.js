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
const fs = require('fs');
const { WebSocketServer } = require('ws');
const uplimit = require('./uplimit');   // บอท Uplimit Media (ต้อนรับ + Ticket) — เดิมรันเป็นโปรเจกต์แยก
const { startRoleWatch, roleWatchStatus } = require('./role-watch');   // ฟังการเปลี่ยนยศแบบสด
const { createTicketFlow, closeTicketFlow } = require('./uplimit/ticket-flow');
const { requestTicketDiscord } = require('./uplimit/ticket-request');

const PORT = process.env.PORT || 4000;

/* ==================================================================
 * ทำความสะอาดค่าที่อ่านจาก environment
 * ปัญหาที่เจอบ่อย: ก๊อปค่าจาก Discord/Upstash มาวางใน Render แล้วติดช่องว่าง
 * หรือขึ้นบรรทัดใหม่ หรืออัญประกาศ ทำให้ไอดี/โทเคนเพี้ยนไป 1 ตัว
 * → ดิสคอร์ดตอบ 401/404 แล้วทั้งระบบดูเหมือน "เชื่อมกับดิสไม่ได้"
 * (ค่าที่ถูกแก้จะถูกจดชื่อไว้ โชว์ได้ในหน้าตรวจระบบ)
 * ================================================================== */
const ENV_FIXED = [];
function envOf(key, { token = false, digits = false } = {}) {
  const raw = String(process.env[key] ?? '');
  let s = raw.trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (token) s = s.replace(/^bot\s+/i, '').replace(/\s+/g, '');   // โทเคนไม่มีช่องว่าง
  if (digits) s = s.replace(/\D/g, '');                           // ไอดิสคอร์ดเป็นตัวเลขล้วน
  if (s && s !== raw) ENV_FIXED.push(key);
  return s;
}

const ADMIN_KEY = envOf('ADMIN_KEY');
const BLOXGATE_API_KEY = envOf('BLOXGATE_API_KEY', { token: true });
const BLOXGATE_ADMIN_USERNAME = envOf('BLOXGATE_ADMIN_USERNAME') || 'Mooni';
const BLOXGATE_ADMIN_PASSWORD = envOf('BLOXGATE_ADMIN_PASSWORD', { token: true });
const { accessForUser, isBloxgateRequest, removeExpiredGrants } = require('./bloxgate');
const BLOXGATE_ADMIN_HTML = fs.readFileSync(__dirname + '/bloxgate-admin.html', 'utf8');

function hasBloxgateAdminAccess(headers) {
  const session = crypto.createHmac('sha256', AUTH_SECRET).update(`bloxgate:${BLOXGATE_ADMIN_USERNAME}`).digest('hex');
  const cookie = String(headers?.cookie || '').match(/(?:^|;\s*)bloxgate_admin=([^;]+)/)?.[1];
  if (cookie && cookie === session) return true;
  const encoded = String(headers?.authorization || '').replace(/^Basic\s+/i, '');
  if (!encoded || !ADMIN_KEY) return false;
  try {
    const [, password] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    return password === ADMIN_KEY;
  } catch { return false; }
}

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
  clientId: envOf('DISCORD_CLIENT_ID', { digits: true }),
  clientSecret: envOf('DISCORD_CLIENT_SECRET', { token: true }),
  guildId: envOf('DISCORD_GUILD_ID', { digits: true }),
  roleId: envOf('DISCORD_ROLE_ID', { digits: true }),
  primeRoleId: envOf('DISCORD_PRIME_ROLE_ID', { digits: true }),   // ยศ Mooni Pro (ปลดล็อก Overlay/Sound)
  mcRoleId: envOf('DISCORD_MC_ROLE_ID', { digits: true }) || '1538119728759832636',   // ยศ Minecraft (ปลดล็อกหน้า Minecraft)
  candyRoleId: envOf('DISCORD_CANDY_ROLE_ID', { digits: true }) || '1533367941691867236',   // ยศ Candy Block (ปลดล็อกการ์ด Candy Block ในหน้า Minecraft)
  farmerRoleId: envOf('DISCORD_FARMER_ROLE_ID', { digits: true }) || '1538127407096270929',   // ยศ Farmer (ปลดล็อกการ์ดแมพ Farmer ในหน้า Minecraft)
  diamondRoleId: envOf('DISCORD_DIAMOND_ROLE_ID', { digits: true }) || '1541417750927376475',   // ยศ Diamond (ปลดล็อกการ์ด Mooni Diamond ในหน้า Minecraft)
  parkourRoleId: envOf('DISCORD_PARKOUR_ROLE_ID', { digits: true }) || '1550867888531968170',
  parkourv2RoleId: envOf('DISCORD_PARKOURV2_ROLE_ID', { digits: true }) || '1556990934401683507',   // ยศ Parkour V2 (ปลดล็อกการ์ด Parkour V2)
  speedrunRoleId: envOf('DISCORD_SPEEDRUN_ROLE_ID', { digits: true }) || '1551020999070322698',   // ยศ Diamond Speedrun (ปลดล็อกการ์ด Diamond Speedrun)   // ยศ Parkour (ปลดล็อกการ์ด Parkour V1 ในหน้า Minecraft)
  game3dRoleId: envOf('DISCORD_GAME3D_ROLE_ID', { digits: true }) || '1569928515179257866',
  fullRoleId: envOf('DISCORD_FULL_ROLE_ID', { digits: true }) || '1529357432000876644',     // ยศเต็ม: ล็อกอิน + ทุกหน้า (ไม่รวมเกม)
  basicRoleId: envOf('DISCORD_BASIC_ROLE_ID', { digits: true }) || '1529344448817791016',   // ยศบางหน้า: ล็อกอิน + หน้าทั่วไป (ไม่รวมเกม)   // ยศ GAME 3D (ปลดล็อกหน้า GAME 3D — เกมร้านข้าวตามสั่ง)
  botToken: envOf('DISCORD_BOT_TOKEN', { token: true }),          // โทเคนบอท — ใช้เช็คยศสดแบบเรียลไทม์ (ถอดยศแล้วรู้ทันที)
  /* ดิสที่สอง (เช็คด้วยบอท) — มียศนี้ในดิสที่สอง = เข้าแอปได้ถาวร ปลดล็อกทุกหน้า/ทุกแมพ ข้ามเช็ควันหมดอายุ */
  guild2Id: envOf('DISCORD_GUILD2_ID', { digits: true }) || '1549377539431206962',
  role2Id: envOf('DISCORD_ROLE2_ID', { digits: true }) || '1550085695110914089',
  publicKey: envOf('DISCORD_PUBLIC_KEY', { token: true }),        // Public Key ของแอป — ใช้ตรวจลายเซ็นปุ่มกดจาก Discord
  invite: envOf('DISCORD_INVITE'),
};
/* บอทตัวที่สอง "☁️Muffin" — ระบบ ticket (ถ้าไม่ตั้ง จะใช้บอท Mooni ตัวเดิมแทน) */
const M = {
  botToken: envOf('MUFFIN_BOT_TOKEN', { token: true }),
  publicKey: envOf('MUFFIN_PUBLIC_KEY', { token: true }),
};
const muffinToken = () => M.botToken || D.botToken;
const muffinKey = () => M.publicKey || D.publicKey;

const AUTH_SECRET = envOf('AUTH_SECRET') || crypto.randomBytes(24).toString('hex');
const SESSION_DAYS = 3;   // บัตรผ่านหมดอายุแล้วต้องล็อกอินใหม่ (เช็คยศซ้ำ) ทุกกี่วัน
const AUTH_ENABLED = !!(D.clientId && D.clientSecret && D.guildId && D.roleId);
const PUBLIC_URL = (envOf('PUBLIC_URL') || envOf('RENDER_EXTERNAL_URL') || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;

/* ==================================================================
 * เก็บ "วันหมดอายุของแต่ละคน" ถาวรที่ Upstash Redis (ฟรี)
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (ตั้งใน Render)
 * เก็บเป็น hash ก้อนเดียวชื่อ mooni:access  (uid -> {exp})
 *   exp = เวลาหมดอายุเป็น ms | 0 = ถาวร | ไม่มี record = ถาวร (ยังไม่จำกัดเวลา)
 * ================================================================== */
const UP = {
  url: envOf('UPSTASH_REDIS_REST_URL').replace(/\/$/, ''),
  token: envOf('UPSTASH_REDIS_REST_TOKEN', { token: true }),
};
const STORE_ENABLED = !!(UP.url && UP.token);

async function upstash(cmd) {
  if (!STORE_ENABLED) return { error: 'no-store' };
  try {
    const r = await fetch(UP.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UP.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(8000),   // Upstash ค้าง = ไม่ให้หน้าแอดมินค้างตาม
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

async function setAccess(uid, rec) {
  if (panelMaps.access) panelMaps.access[uid] = rec;
  return upstash(['HSET', 'mooni:access', uid, JSON.stringify(rec)]);
}
async function delAccess(uid) {
  if (panelMaps.access) delete panelMaps.access[uid];
  return upstash(['HDEL', 'mooni:access', uid]);
}

/**
 * แคชของหน้าแอดมิน: ตาราง "สิทธิ์ใช้แอป" + "วันหมดอายุยศ" จาก Upstash
 * หน้าแอดมินขอข้อมูลบ่อย (เปิดหน้า / รีเฟรช / หลังกดทุกปุ่ม) — อ่าน Upstash ทุกครั้งช้าและเปลือง
 * เก็บไว้ 30 วิ และอัปเดตตามทันทีตอนเราเขียนเอง (write-through) ข้อมูลเลยไม่เก่า
 */
const panelMaps = { at: 0, access: null, roleExp: null, inflight: null };
async function panelLoadMaps(force = false) {
  if (!STORE_ENABLED) return { access: {}, roleExp: {} };
  if (!force && panelMaps.access && Date.now() - panelMaps.at < 30000) return panelMaps;
  if (!panelMaps.inflight) {
    panelMaps.inflight = Promise.all([getAccessMap(), getRoleExpMap()])
      .then(([access, roleExp]) => { panelMaps.access = access; panelMaps.roleExp = roleExp; panelMaps.at = Date.now(); return panelMaps; })
      .finally(() => { panelMaps.inflight = null; });
  }
  return panelMaps.inflight;
}

async function bloxgateRead(key, fallback) {
  const result = await upstash(['GET', key]);
  try { return result?.result ? JSON.parse(result.result) : fallback; } catch { return fallback; }
}
async function bloxgateWrite(key, value) {
  return upstash(['SET', key, JSON.stringify(value)]);
}
const bloxgateMapKey = 'mooni:bloxgate:maps';
const bloxgateGrantKey = (placeId) => `mooni:bloxgate:grants:${placeId}`;

/** ยังไม่หมดอายุไหม (ไม่มี record / exp=0 = ถาวร) */
function accessActive(rec) {
  if (!rec || !rec.exp) return true;
  return rec.exp > Date.now();
}

/* ---------- บอทจัดการยศ + ดึงรายชื่อสมาชิก ---------- */

// ฐานของ Discord API — ตั้ง DISCORD_API_BASE เป็นพร็อกซี่ได้ ถ้า IP ของเซิร์ฟเวอร์ถูกดิสคอร์ดบล็อก
const DC_CUSTOM_BASE = envOf('DISCORD_API_BASE');
const DC_BASE = (DC_CUSTOM_BASE || 'https://discord.com/api').replace(/\/$/, '');
const dcApi = (path) => `${DC_BASE}/v10${path}`;
const ticketRequest = (path, options) => requestTicketDiscord(path, options, {
  customBase: DC_CUSTOM_BASE,
  directBase: 'https://discord.com/api',
});
const botHeaders = () => ({ Authorization: `Bot ${D.botToken}`, 'Content-Type': 'application/json', 'User-Agent': DC_UA });

/**
 * เรียก Discord API แล้วคืนผลพร้อม "สาเหตุจริง"
 * เดิมโค้ดกลืน error เงียบ ๆ (คืน [] / false) ทำให้เวลาดิสเชื่อมไม่ได้
 * หน้าจัดการสมาชิกจะโชว์ว่าว่างเปล่าโดยไม่บอกว่าเกิดอะไรขึ้น
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* นับคำขอที่ยิงไปดิสคอร์ดจริง — โชว์ใน /health */
function countDcCall() { dcCalls += 1; }
// ผู้ใช้ตั้งเองได้ผ่าน env (บางที่ต้องใช้ UA แบบอื่นถึงจะผ่าน Cloudflare ของดิสคอร์ด)
const DC_UA = envOf('DISCORD_UA') || 'DiscordBot (https://mooni-relay.onrender.com, 1.0)';
const DC_UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** ยิงคำขอเดียวไปดิสคอร์ดเพื่อดูว่าผ่านไหม (ใช้ตอนตรวจสุขภาพ) */
async function probeDiscord(ua) {
  try {
    const r = await fetch(`${DC_BASE}/v10/users/@me`, {
      headers: { Authorization: `Bot ${D.botToken}`, 'User-Agent': ua },
    });
    const txt = r.status === 204 ? '' : await r.text();
    return { status: r.status, ok: r.ok, html: /^\s*<(?:!doctype|html)/i.test(txt) };
  } catch (e) { return { status: 0, ok: false, html: false, reason: String(e?.message || e).slice(0, 80) }; }
}

async function dcFetch(path, { token = D.botToken, method = 'GET', body, tries = 3 } = {}) {
  const out = { ok: false, status: 0, code: 0, error: '', html: false, data: null };
  if (!token) { out.error = 'no-token'; return out; }
  for (let attempt = 1; attempt <= tries; attempt++) {
    let r;
    try {
      countDcCall();
      r = await fetch(dcApi(path), {
        method,
        // ใส่ User-Agent ให้ครบ — บางครั้งดิสคอร์ด/Cloudflare ตีกลับถ้าไม่มี
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': DC_UA },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      out.status = 0;
      out.error = 'network: ' + (e?.message || e);
      if (attempt < tries) { await sleep(400 * attempt); continue; }
      return out;
    }
    out.status = r.status;
    out.ok = r.ok;
    out.data = null;
    out.raw = undefined;
    if (r.status !== 204) {
      const txt = await r.text();
      try { out.data = JSON.parse(txt); } catch { out.data = null; out.raw = String(txt).slice(0, 300); out.html = /^\s*<(?:!doctype|html)/i.test(txt); }
    }
    if (!r.ok) {
      out.code = out.data?.code || 0;
      out.error = out.data?.message || out.raw || ('HTTP ' + out.status);
      // โดนจำกัดหรือเซิร์ฟเวอร์ดิสคอร์ดสะดุด — ลองซ้ำตาม Retry-After ก่อนรายงาน
      if ((r.status === 429 || r.status >= 500) && attempt < tries) {
        const ra = Number(r.headers.get('retry-after') || 0) * 1000;
        await sleep(ra > 0 ? Math.min(ra, 5000) : 500 * attempt);
        continue;
      }
    }
    return out;
  }
  return out;
}

/** ข้อความ error ให้อ่านง่าย (กัน "HTTP 401 401: Unauthorized" ซ้ำซ้อน) */
function dcErrText(api) {
  const st = api?.status || 0;
  const msg = String(api?.error || 'unknown');
  if (!st) return msg;
  if (api?.html) return 'HTTP ' + st + ' — ดิสคอร์ด/Cloudflare ตอบกลับเป็นหน้า HTML (คำขอจาก IP ของเซิร์ฟเวอร์นี้ถูกบล็อก ไม่ใช่โทเคนผิด)';
  return msg.startsWith(String(st)) ? msg : 'HTTP ' + st + ' ' + msg;
}

/** แปลงรหัส error ของดิสคอร์ด เป็นคำแนะนำที่แก้ได้จริง */
function dcHint(status, code) {
  if (!status) return 'ติดต่อ discord.com ไม่ได้จากเซิร์ฟเวอร์นี้ — เช็คเครือข่าย/ดู log บน Render';
  if (status === 401) return 'โทเคนบอทไม่ถูกต้องหรือถูกยกเลิก — Discord Developer Portal → Bot → Reset Token แล้วอัปเดตค่าใน Render (DISCORD_BOT_TOKEN / MUFFIN_BOT_TOKEN) แล้ว Redeploy';
  if (status === 403 && code === 50001) return 'บอทไม่เห็นข้อมูลนี้ — เช็คว่าเชิญบอทเข้าเซิร์ฟเวอร์แล้ว และเปิด Server Members Intent (ถ้าเป็นเรื่องรายชื่อสมาชิก)';
  if (status === 403 && code === 50013) return 'บอทขาดสิทธิ์ — ตั้ง Manage Roles / Manage Channels และลากยศบอทให้สูงกว่ายศที่บอทจะจัดการ';
  if (status === 403) return 'ถูกปฏิเสธสิทธิ์ (403) — เช็คสิทธิ์บอทและ intent ในหน้า Developer Portal';
  if (status === 404 && code === 10004) return 'ไม่พบเซิร์ฟเวอร์ — ไอดี DISCORD_GUILD_ID ไม่ถูกต้อง หรือบอทไม่ได้อยู่ในเซิร์ฟเวอร์นั้น';
  if (status === 404 && code === 10003) return 'ไม่พบห้อง/หมวดหมู่นี้ — ไอดีห้องผิด หรือบอทไม่เห็นห้องนั้น';
  if (status === 404 && code === 10011) return 'ไม่พบยศนี้ — ไอดียศผิด หรือยศถูกลบไปแล้ว';
  if (status === 429) return 'ดิสคอร์ดหน่วง/บล็อกคำขอจาก IP นี้ — ระบบลองซ้ำให้แล้ว ถ้าเป็นทุกครั้งให้ Redeploy/Restart เพื่อเปลี่ยน IP หรือย้ายโฮสต์ (Railway/VPS)';
  return 'ดูข้อความจากดิสคอร์ดด้านบน';
}

/** ให้/ถอดยศ พร้อมรายละเอียดว่าล้มเพราะอะไร */
/* ---------- แคชคำตอบจากดิสคอร์ดสั้น ๆ ----------
 * แอปทุกเครื่องจะถาม "ยศยังใช้ได้ไหม" ซ้ำ ๆ — ถ้าถามดิสคอร์ดตรง ๆ ทุกครั้ง
 * จะกินโควตารวมของ IP (IP ร่วมกับผู้เช่ารายอื่นบน Render) แล้วโดนแบนได้
 * แคชไว้ไม่กี่สิบวินาที = ตอบเร็วขึ้นและลดคำขอจริงลงหลายเท่า
 */
const dcCache = new Map();
let dcCalls = 0;   // นับคำขอที่ยิงไปดิสคอร์ดจริง (ดูได้ใน /health)
function cacheGet(key) {
  const e = dcCache.get(key);
  return e && Date.now() - e.at < e.ttl ? e.v : null;
}
function cacheSet(key, v, ttl = 20000) {   // 20 วิ — ยศเปลี่ยนปกติรู้ทันทีจาก role-watch นี่คือสำรองตอน gateway หลุด
  if (dcCache.size > 4000) dcCache.clear();
  dcCache.set(key, { at: Date.now(), v, ttl });
  return v;
}
/** ล้างแคชของสมาชิกคนนี้ (หลังให้/ถอดยศ จะได้เห็นผลทันที) */
function cacheDropUid(uid) {
  const tail = ':' + uid;
  for (const k of dcCache.keys()) if (k.endsWith(tail)) dcCache.delete(k);
}

/** ให้/ถอดยศ พร้อมรายละเอียดว่าล้มเพราะอะไร */
async function botSetRoleDetail(uid, roleId, on) {
  if (!D.botToken || !roleId) return { ok: false, status: 0, code: 0, error: 'no-token-or-role', hint: '' };
  const r = await dcFetch(`/guilds/${D.guildId}/members/${uid}/roles/${roleId}`, { method: on ? 'PUT' : 'DELETE' });
  if (r.ok) {
    cacheDropUid(uid);   // ยศเปลี่ยน → ล้างแคชของคนนี้ ให้เช็คครั้งต่อไปเห็นผลทันที
    patchCachedMemberRole(uid, roleId, on);   // รายชื่อในหน้าแอดมินเห็นผลทันที ไม่ต้องรอแคชหมดอายุ
    return { ok: true, status: r.status, code: 0, error: '', hint: '' };
  }
  return { ok: false, status: r.status, code: r.code, error: r.error, hint: dcHint(r.status, r.code) };
}
async function botSetRole(uid, roleId, on) {
  const r = await botSetRoleDetail(uid, roleId, on);
  return r.ok;
}

/** แก้ยศในรายชื่อสมาชิกที่แคชไว้ (members:all) ตรง ๆ แทนการล้างทิ้งแล้วดึงทั้งเซิร์ฟเวอร์ใหม่ */
function patchCachedMemberRole(uid, roleId, on) {
  const e = dcCache.get('members:all');
  if (!e || !e.v || !Array.isArray(e.v.members)) return;
  const flagOf = { [D.roleId]: 'mooni', [D.primeRoleId]: 'prime', [D.mcRoleId]: 'mc', [D.candyRoleId]: 'candy', [D.farmerRoleId]: 'farmer', [D.diamondRoleId]: 'diamond', [D.parkourRoleId]: 'parkour', [D.parkourv2RoleId]: 'parkourv2', [D.speedrunRoleId]: 'speedrun', [D.game3dRoleId]: 'game3d' };
  const flag = flagOf[roleId];
  const m = e.v.members.find((x) => x.uid === String(uid));
  if (flag && m) m[flag] = !!on;
}

function memberAvatar(m) {
  const uid = m.user?.id;
  if (m.avatar) return `https://cdn.discordapp.com/guilds/${D.guildId}/users/${uid}/avatars/${m.avatar}.png?size=64`;
  if (m.user?.avatar) return `https://cdn.discordapp.com/avatars/${uid}/${m.user.avatar}.png?size=64`;
  return '';
}

/** ดึงสมาชิกทั้งเซิร์ฟเวอร์ (ต้องเปิด Server Members Intent) */
async function botListMembers() {
  if (!D.botToken) return { members: [], ok: false, status: 0, error: 'no-token', hint: 'ยังไม่ได้ตั้ง DISCORD_BOT_TOKEN ใน Render' };
  const hit = cacheGet('members:all');
  if (hit) return hit;
  const res = await dcFetch(`/guilds/${D.guildId}/members?limit=1000`);
  if (!res.ok) {
    return cacheSet('members:all', { members: [], ok: false, status: res.status, code: res.code, error: res.error || 'unknown', hint: dcHint(res.status, res.code) }, 20000);
  }
  const arr = Array.isArray(res.data) ? res.data : [];
  const out = { ok: true, status: 200, error: '', count: arr.length, members: arr.filter((m) => !m.user?.bot).map((m) => ({
      uid: m.user.id,
      name: m.nick || m.user.global_name || m.user.username,
      avatar: memberAvatar(m),
      mooni: Array.isArray(m.roles) && m.roles.includes(D.roleId),
      prime: D.primeRoleId ? (Array.isArray(m.roles) && m.roles.includes(D.primeRoleId)) : false,
      mc: D.mcRoleId ? (Array.isArray(m.roles) && m.roles.includes(D.mcRoleId)) : false,
      candy: D.candyRoleId ? (Array.isArray(m.roles) && m.roles.includes(D.candyRoleId)) : false,
      farmer: D.farmerRoleId ? (Array.isArray(m.roles) && m.roles.includes(D.farmerRoleId)) : false,
      diamond: D.diamondRoleId ? (Array.isArray(m.roles) && m.roles.includes(D.diamondRoleId)) : false,
      parkour: D.parkourRoleId ? (Array.isArray(m.roles) && m.roles.includes(D.parkourRoleId)) : false,
      parkourv2: D.parkourv2RoleId ? (Array.isArray(m.roles) && m.roles.includes(D.parkourv2RoleId)) : false,
      speedrun: D.speedrunRoleId ? (Array.isArray(m.roles) && m.roles.includes(D.speedrunRoleId)) : false,
      game3d: D.game3dRoleId ? (Array.isArray(m.roles) && m.roles.includes(D.game3dRoleId)) : false,
    })) };
  return cacheSet('members:all', out, 60000);
}

/** ข้อมูลสมาชิก 1 คนสำหรับหน้าแอดมิน (ยศ + วันหมดอายุแต่ละยศ + ออนไลน์ไหม) */
function panelMember(m, maps) {
  const accessMap = maps.access || {};
  const roleExpMap = maps.roleExp || {};
  const ex = (rid) => (rid ? (roleExpMap[`${m.uid}:${rid}`] || 0) : 0);
  return {
    ...m,
    exp: accessMap[m.uid]?.exp || 0,
    mcExp: ex(D.mcRoleId), mooniExp: ex(D.roleId), primeExp: ex(D.primeRoleId),
    candyExp: ex(D.candyRoleId), farmerExp: ex(D.farmerRoleId), diamondExp: ex(D.diamondRoleId),
    parkourExp: ex(D.parkourRoleId), parkourv2Exp: ex(D.parkourv2RoleId), speedrunExp: ex(D.speedrunRoleId),
    game3dExp: ex(D.game3dRoleId),
    active: (Date.now() - (lastSeen.get(m.uid) || 0)) < ACTIVE_WINDOW,
  };
}

/** หลังแก้ยศ/เวลา: ส่งข้อมูลล่าสุดของคนนั้นกลับไป หน้าแอดมินจะได้อัปเดตแค่การ์ดเดียว */
async function panelMemberOf(uid) {
  const listRes = cacheGet('members:all');
  const base = listRes?.members?.find((x) => x.uid === String(uid));
  if (!base) return null;
  return panelMember(base, await panelLoadMaps());
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
      method: 'POST', headers: { Authorization: `Bot ${D.botToken}`, 'User-Agent': DC_UA }, body: fd,
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

const hdr = (token) => ({ Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': DC_UA });

/**
 * ยศทีมงานเพิ่มเติมจาก env (คั่นด้วยจุลภาค) — ใช้ได้กับ "ปุ่มที่ส่งไปแล้ว" ด้วย
 * เช่น TICKET_STAFF_ROLES=1484626455928373279,1484626578943246518
 */
const TICKET_STAFF_EXTRA = String(process.env.TICKET_STAFF_ROLES || '')
  .split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);

/** รวมยศทีมงานทั้งจากปุ่มและจาก env */
const staffRoleSet = (fromButton) => new Set([...(fromButton || []), ...TICKET_STAFF_EXTRA]);

/** คนกดมียศทีมงานไหม */
function isTicketStaff(memberRoles, fromButton) {
  const allowed = staffRoleSet(fromButton);
  return (memberRoles || []).some((r) => allowed.has(r));
}

// สิทธิ์: VIEW_CHANNEL(1024) + SEND_MESSAGES(2048) + READ_MESSAGE_HISTORY(65536) + ATTACH_FILES(32768)
const TICKET_ALLOW = String(1024 + 2048 + 65536 + 32768);
// บอท Muffin ต้องมี Manage Channels (16) ในห้องเอง เพื่อปิด Ticket ได้แม้หมวดหมู่ตั้งสิทธิ์เข้มงวด
const TICKET_BOT_ALLOW = String(1024 + 2048 + 65536 + 32768 + 16);
const VIEW_ONLY = '1024';

/** แก้ข้อความตอบกลับที่ค้างไว้ (หลังตอบ deferred) — ใช้ interaction token ไม่ต้องใช้โทเคนบอท */
async function editOriginal(appId, itoken, content) {
  try {
    const response = await ticketRequest(`/webhooks/${appId}/${itoken}/messages/@original`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    });
    if (!response.ok) console.error('[ticket] อัปเดตข้อความไม่สำเร็จ: Discord ' + response.status);
  } catch (err) { console.error('[ticket] อัปเดตข้อความไม่สำเร็จ:', err.message); }
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
    r = await ticketRequest(`/channels/${channelId}/messages`, {
      method: 'POST', headers: { Authorization: `Bot ${token}`, 'User-Agent': DC_UA }, body: fd,
    });
  } else {
    r = await ticketRequest(`/channels/${channelId}/messages`, {
      method: 'POST', headers: hdr(token), body: JSON.stringify(payload),
    });
  }
  if (r.ok) return { ok: true };
  let detail = ''; try { detail = (await r.json())?.message || ''; } catch {}
  return { ok: false, status: r.status, detail };
}

/** สร้างห้อง ticket ให้คนที่กดปุ่ม (ทำหลังตอบ deferred แล้ว) */
async function createTicket(body, staffRoleIds, categoryId) {
  const staffIds = [...staffRoleSet(String(staffRoleIds || '').split(',').filter(Boolean))];
  const token = muffinToken();
  const appId = body.application_id, itoken = body.token;
  const guildId = body.guild_id || D.guildId;
  const user = body.member?.user;
  const uid = user?.id;
  if (!uid) return editOriginal(appId, itoken, 'อ่านข้อมูลผู้ใช้ไม่ได้');

  const uname = String(user.username || 'user').toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 20) || 'user';

  return createTicketFlow({
    // กันเปิดซ้ำ — หาห้องเดิมในหมวดนี้ที่ topic มีไอดีเขา
    findExisting: async () => {
      try {
        const chs = await ticketRequest(`/guilds/${guildId}/channels`, {
          headers: hdr(token), signal: AbortSignal.timeout(8000),
        }).then((r) => r.json());
        return Array.isArray(chs) && chs.find(
          (c) => c.parent_id === categoryId && String(c.topic || '').includes(`ticket:${uid}`),
        );
      } catch (err) {
        // Keep the previous behaviour (a temporary lookup error must not stop a buyer),
        // but record it for Render diagnostics instead of hiding it.
        console.warn('[ticket] ตรวจ Ticket เดิมไม่ได้:', err.message);
        return null;
      }
    },
    createChannel: async () => {
      const res = await ticketRequest(`/guilds/${guildId}/channels`, {
        method: 'POST', headers: hdr(token), signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          name: `ticket-${uname}`,
          type: 0,
          parent_id: categoryId,
          topic: `ticket:${uid}`,
          permission_overwrites: [
            { id: guildId, type: 0, deny: VIEW_ONLY },
            { id: uid, type: 1, allow: TICKET_ALLOW },
            { id: body.application_id, type: 1, allow: TICKET_BOT_ALLOW },
            ...staffIds.map((rid) => ({ id: rid, type: 0, allow: TICKET_ALLOW })),
          ],
        }),
      });
      const channel = await res.json().catch(() => ({}));
      if (!channel?.id) {
        throw new Error(`Discord ${res.status}: ${channel?.message || 'สร้างห้องไม่สำเร็จ'}`);
      }
      return channel;
    },
    announceExisting: (id) => editOriginal(appId, itoken, `คุณมีห้องที่เปิดอยู่แล้ว → <#${id}>`),
    announceOpened: (id) => editOriginal(appId, itoken, `เปิดห้องให้แล้ว → <#${id}>`),
    // ไม่ให้การส่งข้อความต้อนรับมาบล็อกการตอบลิงก์ห้อง Ticket
    sendWelcome: (channelId) => ticketRequest(`/channels/${channelId}/messages`, {
      method: 'POST', headers: hdr(token), signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        content: `<@${uid}> ${staffIds.map((r) => `<@&${r}>`).join(' ')}`,
        embeds: [{
          color: 0x8ec9ff,
          description: '📩 เปิด Ticket เรียบร้อย — พิมพ์เรื่องที่ต้องการได้เลย รอทีมงานสักครู่นะ\n\n*ปุ่มด้านล่างใช้ได้เฉพาะทีมงานเท่านั้น*',
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: '✅ สำเร็จ', custom_id: `tk:d:${staffIds.slice(0, 3).join(',')}` },
            { type: 2, style: 4, label: '🔒 ปิดห้อง', custom_id: `tk:c:${staffIds.slice(0, 3).join(',')}` },
          ],
        }],
      }),
    }).then((res) => {
      if (!res.ok) throw new Error(`Discord ${res.status}`);
    }),
    onWelcomeError: (err) => console.error('[ticket] ส่งข้อความต้อนรับไม่สำเร็จ:', err.message),
  });
}

/* ---------- ร้านค้า (Shop) ---------- */

const SHOP_HTML = require('./shop-page');

/** ตั้งค่าร้าน (ชื่อร้าน/พร้อมเพย์/ห้องแอดมิน) เก็บใน Upstash */
async function getShopSettings() {
  const d = await upstash(['GET', 'mooni:shop']);
  try { return d.result ? JSON.parse(d.result) : {}; } catch { return {}; }
}
const setShopSettings = (obj) => upstash(['SET', 'mooni:shop', JSON.stringify(obj)]);

/** รายการสินค้า */
async function getProducts() {
  const d = await upstash(['HGETALL', 'mooni:products']);
  const arr = d.result || [];
  const out = [];
  for (let i = 0; i < arr.length; i += 2) {
    try { out.push({ id: arr[i], ...JSON.parse(arr[i + 1]) }); } catch { /* ข้าม */ }
  }
  return out.sort((a, b) => (a.order || 0) - (b.order || 0));
}
const setProduct = (id, p) => upstash(['HSET', 'mooni:products', id, JSON.stringify(p)]);
const delProduct = (id) => upstash(['HDEL', 'mooni:products', id]);

const getOrder = async (id) => {
  const d = await upstash(['HGET', 'mooni:orders', id]);
  try { return d.result ? JSON.parse(d.result) : null; } catch { return null; }
};
const setOrder = (id, o) => upstash(['HSET', 'mooni:orders', id, JSON.stringify(o)]);

/** ตัวกลางจัดการร้าน (ใช้ทั้งหน้า /panel และแถบหลังบ้านใน /shop) */
async function doShopAdmin(action, data) {
  if (!STORE_ENABLED) return { code: 400, body: { error: 'ยังไม่ได้ตั้ง Upstash' } };

  if (action === 'get') {
    const [settings, products] = await Promise.all([getShopSettings(), getProducts()]);
    return { code: 200, body: { settings, products } };
  }
  if (action === 'settings') {
    const cur = await getShopSettings();
    const next = {
      ...cur,
      shopName: String(data.shopName ?? cur.shopName ?? '').slice(0, 60),
      shopNote: String(data.shopNote ?? cur.shopNote ?? '').slice(0, 200),
      payNumber: String(data.payNumber ?? cur.payNumber ?? '').slice(0, 60),
      payName: String(data.payName ?? cur.payName ?? '').slice(0, 60),
      adminChannelId: String(data.adminChannelId ?? cur.adminChannelId ?? '').trim(),
    };
    if (data.payQr) next.payQr = String(data.payQr).slice(0, 500000);
    if (data.payQr === '') delete next.payQr;
    if (typeof data.freeVerify === 'boolean') next.freeVerify = data.freeVerify;
    if (typeof data.checkAmount === 'boolean') next.checkAmount = data.checkAmount;
    await setShopSettings(next);
    broadcast({ type: 'shop:update' });
    return { code: 200, body: { ok: true } };
  }
  if (action === 'product') {
    const name = String(data.name || '').trim();
    const roleId = String(data.roleId || '').trim();
    const price30 = Math.max(0, Math.round(Number(data.price30) || 0));
    const price90 = Math.max(0, Math.round(Number(data.price90) || 0));
    if (!name) return { code: 400, body: { error: 'ใส่ชื่อสินค้า' } };
    if (!/^\d{5,}$/.test(roleId)) return { code: 400, body: { error: 'ไอดียศไม่ถูกต้อง' } };
    if (!price30 && !price90) return { code: 400, body: { error: 'ใส่ราคาอย่างน้อย 1 แบบ (30 หรือ 90 วัน)' } };
    const id = String(data.id || '').trim() || (Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
    const prev = (await getProducts()).find((p) => p.id === id) || {};
    await setProduct(id, {
      name, desc: String(data.desc || '').slice(0, 500), roleId, price30, price90,
      active: data.active !== false,
      order: Number(data.order) || prev.order || Date.now(),
      image: data.image !== undefined ? String(data.image).slice(0, 600000) : prev.image || '',
    });
    broadcast({ type: 'shop:update' });
    return { code: 200, body: { ok: true, id } };
  }
  if (action === 'delproduct') {
    await delProduct(String(data.id || ''));
    broadcast({ type: 'shop:update' });
    return { code: 200, body: { ok: true } };
  }
  return { code: 404, body: { error: 'not found' } };
}

/* ---------- ล็อกอินหลังบ้านร้าน (ผ่านยศ Discord แทนรหัสแอดมิน) ---------- */
const SHOP_ADMIN_ROLES = String(process.env.SHOP_ADMIN_ROLES || '1484626578943246518,1484626455928373279')
  .split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);

function signShopCookie(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', AUTH_SECRET).update('shopadmin.' + body).digest('base64url');
  return `${body}.${mac}`;
}
function verifyShopCookie(tok) {
  const [body, mac] = String(tok || '').split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', AUTH_SECRET).update('shopadmin.' + body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function getCookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

/** ดึงยศปัจจุบันของสมาชิกด้วยบอท */
async function fetchMemberRoles(uid) {
  if (!D.botToken || !uid) return null;
  try {
    countDcCall();
    const r = await fetch(dcApi(`/guilds/${D.guildId}/members/${uid}`), { headers: botHeaders() });
    if (!r.ok) return null;
    const m = await r.json();
    return { roles: m.roles || [], name: m.nick || m.user?.global_name || m.user?.username || '' };
  } catch { return null; }
}
const isShopAdminRoles = (roles) => (roles || []).some((r) => SHOP_ADMIN_ROLES.includes(r));

/** เช็คคุกกี้ + ยศสด — คืน {uid,name} ถ้าเป็นแอดมินร้าน, null ถ้าไม่ใช่ */
async function shopAdminFromReq(req) {
  const p = verifyShopCookie(getCookie(req, 'mooni_shop'));
  if (!p?.uid) return null;
  const m = await fetchMemberRoles(p.uid);
  if (!m || !isShopAdminRoles(m.roles)) return null;
  return { uid: p.uid, name: m.name };
}

// กันสแปมสั่งซื้อ: ip -> เวลาสั่งล่าสุด
const orderThrottle = new Map();

/* ---------- ตรวจสลิปอัตโนมัติ (EasySlip) ---------- */
const EASYSLIP_TOKEN = envOf('EASYSLIP_TOKEN', { token: true });
const AUTO_SLIP = !!EASYSLIP_TOKEN;

/* ---------- โหมดฟรี: อ่าน QR ในสลิปเอง (pure-JS ไม่ต้องต่อ API) ---------- */
let jsQR, jpegDec, PNGlib;
try { jsQR = require('jsqr'); jpegDec = require('jpeg-js'); PNGlib = require('pngjs').PNG; } catch { /* ยังไม่ได้ลง */ }
const FREE_QR_AVAILABLE = !!(jsQR && jpegDec && PNGlib);

/* ---------- อ่านยอดเงินในสลิปด้วย OCR (โหมดฟรี) ---------- */
let Tesseract; try { Tesseract = require('tesseract.js'); } catch { /* ยังไม่ได้ลง */ }
const OCR_AVAILABLE = !!Tesseract;
let ocrWorker = null, ocrQueue = Promise.resolve();

async function getOcrWorker() {
  if (!ocrWorker) ocrWorker = await Tesseract.createWorker(['tha', 'eng']);
  return ocrWorker;
}

/** อ่านยอดเงินจากสลิป → คืนตัวเลข (บาท) หรือ null ถ้าอ่านไม่ได้ */
function ocrAmount(buf) {
  if (!OCR_AVAILABLE) return Promise.resolve(null);
  const run = async () => {
    try {
      const w = await getOcrWorker();
      const { data } = await w.recognize(buf);
      const t = String(data.text || '').replace(/\s+/g, ' ');
      // ลำดับความมั่นใจ: "เลข บาท" > "จำนวน...เลข" > เลขทศนิยมตัวแรก
      const m = t.match(/([\d,]+\.\d{2})\s*บาท/) || t.match(/จำนวน\D{0,8}([\d,]+\.\d{2})/) || t.match(/([\d,]+\.\d{2})/);
      return m ? Number(m[1].replace(/,/g, '')) : null;
    } catch { return null; }
  };
  // ทำทีละงาน กันแรมพุ่งตอนหลายออเดอร์พร้อมกัน
  const p = ocrQueue.then(run, run);
  ocrQueue = p.catch(() => {});
  return p;
}

/** อ่าน QR ยืนยันสลิปจากรูป → คืน payload (สตริง) หรือ null ถ้าไม่พบ */
function readSlipQR(buf) {
  if (!FREE_QR_AVAILABLE) return null;
  try {
    let img;
    if (buf[0] === 0x89 && buf[1] === 0x50) {            // PNG
      const p = PNGlib.sync.read(buf); img = { data: p.data, width: p.width, height: p.height };
    } else if (buf[0] === 0xFF && buf[1] === 0xD8) {     // JPEG
      const j = jpegDec.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 }); img = { data: j.data, width: j.width, height: j.height };
    } else return null;
    const code = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
    return code?.data || null;
  } catch { return null; }
}

/** ส่งรูปสลิปให้ EasySlip (API v2) ตรวจกับธนาคาร → คืนยอด + เลขอ้างอิง */
async function verifySlip(buf, filename) {
  try {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), filename || 'slip.jpg');
    const r = await fetch('https://api.easyslip.com/v2/verify/bank', {
      method: 'POST', headers: { Authorization: `Bearer ${EASYSLIP_TOKEN}` }, body: fd,
    });
    const d = await r.json().catch(() => ({}));
    if (!d.success || !d.data) {
      const map = {
        invalid_payload: 'อ่าน QR ในสลิปไม่ได้', image_not_found: 'ไม่พบรูปสลิป',
        slip_not_found: 'ตรวจไม่พบรายการนี้ (สลิปอาจปลอม/ยังไม่ขึ้นระบบธนาคาร)',
        quota_exceeded: 'โควตาตรวจสลิปหมด', duplicate_slip: 'สลิปนี้ถูกใช้ไปแล้ว',
        account_not_found: 'บัญชีไม่ถูกต้อง', invalid_token: 'token EasySlip ไม่ถูกต้อง',
      };
      return { ok: false, error: map[d.message] || d.message || `ตรวจสลิปไม่ผ่าน (${r.status})` };
    }
    const dt = d.data;
    const amount = dt.amount?.amount ?? dt.amount?.local?.amount ?? 0;
    const transRef = dt.transRef || dt.payload || '';
    const recv = dt.receiver?.account?.bank?.account || dt.receiver?.account?.proxy?.account || '';
    return { ok: true, amount: Number(amount) || 0, transRef: String(transRef || ''), receiver: String(recv || '') };
  } catch (e) { return { ok: false, error: 'เชื่อมระบบตรวจสลิปไม่ได้' }; }
}

/** ยศที่ซื้อแบบมีวันหมดอายุ — เก็บ (uid:roleId -> เวลา ms) แล้วกวาดถอดเองเมื่อหมดอายุ */
const setRoleExpiry = (uid, roleId, exp) => {
  if (panelMaps.roleExp) panelMaps.roleExp[`${uid}:${roleId}`] = Number(exp) || 0;
  return upstash(['HSET', 'mooni:roleexp', `${uid}:${roleId}`, String(exp)]);
};
const delRoleExpiry = (uid, roleId) => {
  if (panelMaps.roleExp) delete panelMaps.roleExp[`${uid}:${roleId}`];
  return upstash(['HDEL', 'mooni:roleexp', `${uid}:${roleId}`]);
};

/** อ่านวันหมดอายุยศทั้งหมด → map ของ "uid:roleId" -> เวลา ms */
async function getRoleExpMap() {
  if (!STORE_ENABLED) return {};
  const d = await upstash(['HGETALL', 'mooni:roleexp']);
  const arr = d.result || [];
  const map = {};
  for (let i = 0; i < arr.length; i += 2) map[arr[i]] = Number(arr[i + 1]) || 0;
  return map;
}

/** วันหมดอายุของยศทั้งหมดของผู้ใช้ → map ตามชื่อยศ → เวลา ms (0 = ถาวร/ไม่มีข้อมูล) */
function roleExpOf(uid, D, roleExpMap) {
  return {
    mc: roleExpMap[`${uid}:${D.mcRoleId}`] || 0,
    mooni: roleExpMap[`${uid}:${D.roleId}`] || 0,
    prime: roleExpMap[`${uid}:${D.primeRoleId}`] || 0,
    candy: roleExpMap[`${uid}:${D.candyRoleId}`] || 0,
    farmer: roleExpMap[`${uid}:${D.farmerRoleId}`] || 0,
    diamond: roleExpMap[`${uid}:${D.diamondRoleId}`] || 0,
    parkour: roleExpMap[`${uid}:${D.parkourRoleId}`] || 0,
    parkourv2: roleExpMap[`${uid}:${D.parkourv2RoleId}`] || 0,
    speedrun: roleExpMap[`${uid}:${D.speedrunRoleId}`] || 0,
    game3d: roleExpMap[`${uid}:${D.game3dRoleId}`] || 0,
  };
}

async function sweepRoleExpiry() {
  if (!STORE_ENABLED || !D.botToken) return;
  const d = await upstash(['HGETALL', 'mooni:roleexp']);
  const arr = d.result || [];
  const now = Date.now();
  for (let i = 0; i < arr.length; i += 2) {
    const key = arr[i], exp = Number(arr[i + 1]) || 0;
    if (exp && exp <= now) {
      const [uid, roleId] = key.split(':');
      if (uid && roleId) await botSetRole(uid, roleId, false).catch(() => {});
      await upstash(['HDEL', 'mooni:roleexp', key]);
    }
  }
}
// กวาดยศหมดอายุทุก 5 นาที (ทำได้เมื่อ relay ตื่นอยู่ — ตั้ง UptimeRobot ช่วยให้ตื่นตลอด)
setInterval(() => sweepRoleExpiry().catch(() => {}), 5 * 60 * 1000).unref?.();

/** ส่งคำสั่งซื้อ + สลิป เข้าห้องแอดมินใน Discord พร้อมปุ่มอนุมัติ/ปฏิเสธ */
async function postOrderToDiscord({ orderId, channelId, product, price, days, discordId, note, slipBuf, slipName, memberName, autoDone }) {
  const token = muffinToken();
  const statusLine = autoDone === 'approved' ? '✅ ตรวจสลิปอัตโนมัติผ่าน — ให้ยศแล้ว'
    : autoDone === 'failed' ? '⚠️ สลิปผ่าน แต่ให้ยศไม่สำเร็จ (เช็คสิทธิ์บอท)' : '';
  const payload = {
    content: autoDone ? `🧾 บันทึกคำสั่งซื้อ <@${discordId}>` : `🛒 คำสั่งซื้อใหม่ <@${discordId}>`,
    embeds: [{
      color: autoDone === 'failed' ? 0xffcf3d : 0xf2a8c4,
      title: `🛒 ${product.name}${days ? ` · ${days} วัน` : ''}`,
      description: [
        statusLine,
        `**ราคา:** ฿${Number(price || 0).toLocaleString('th-TH')}`,
        days ? `**ระยะเวลา:** ${days} วัน` : '',
        `**ผู้ซื้อ:** <@${discordId}> \`${discordId}\`${memberName ? ` (${memberName})` : ''}`,
        note ? `**หมายเหตุ:** ${String(note).slice(0, 300)}` : '',
        `**ยศ:** <@&${product.roleId}>`,
        `**เลขที่:** \`${orderId}\``,
      ].filter(Boolean).join('\n'),
      image: { url: `attachment://${slipName}` },
      footer: { text: autoDone ? 'ตรวจสลิปอัตโนมัติ' : 'กดอนุมัติเพื่อให้ยศ' },
    }],
    // โหมด auto = เป็น log เฉย ๆ ไม่ต้องมีปุ่ม
    ...(autoDone ? {} : {
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: '✅ อนุมัติ', custom_id: `sh:a:${orderId}` },
          { type: 2, style: 4, label: '❌ ปฏิเสธ', custom_id: `sh:r:${orderId}` },
        ],
      }],
    }),
  };

  const fd = new FormData();
  fd.append('payload_json', JSON.stringify(payload));
  fd.append('files[0]', new Blob([slipBuf]), slipName);
  const r = await fetch(dcApi(`/channels/${channelId}/messages`), {
    method: 'POST', headers: { Authorization: `Bot ${token}` }, body: fd,
  });
  if (r.ok) return { ok: true };
  let detail = ''; try { detail = (await r.json())?.message || ''; } catch {}
  return { ok: false, status: r.status, detail };
}

/** รับคำสั่งซื้อจากหน้าร้าน → เก็บ order + ส่งเข้าห้องแอดมินพร้อมสลิป */
async function handleShopOrder(data, req) {
  if (!STORE_ENABLED) return { code: 503, body: { error: 'ระบบยังไม่พร้อม (ยังไม่ได้ตั้งคลังข้อมูล)' } };

  const discordId = String(data.discordId || '').trim();
  if (!/^\d{15,25}$/.test(discordId)) return { code: 400, body: { error: 'Discord User ID ไม่ถูกต้อง' } };

  const product = (await getProducts()).find((p) => p.id === data.productId && p.active !== false);
  if (!product) return { code: 400, body: { error: 'ไม่พบสินค้านี้' } };
  if (!product.roleId) return { code: 400, body: { error: 'สินค้านี้ยังไม่ได้ตั้งยศ' } };

  // ระยะเวลา 30/90 วัน (0 = ไม่จำกัด) + ราคาตามระยะเวลา
  const days = Number(data.days) || 0;
  const price = days === 30 ? product.price30 : days === 90 ? product.price90 : (product.price || product.price30 || product.price90);
  if (!price) return { code: 400, body: { error: 'ระยะเวลาที่เลือกไม่ถูกต้อง' } };

  const settings = await getShopSettings();
  if (!settings.adminChannelId) return { code: 503, body: { error: 'ร้านยังไม่ได้ตั้งห้องรับออเดอร์' } };
  if (!muffinToken()) return { code: 503, body: { error: 'ร้านยังไม่ได้ตั้งบอท' } };

  // กันสแปม: 1 คำสั่ง/ไอพี ต่อ 10 วิ
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (Date.now() - (orderThrottle.get(ip) || 0) < 10000) return { code: 429, body: { error: 'ช้าก่อน ลองใหม่อีกครั้งใน 10 วิ' } };
  orderThrottle.set(ip, Date.now());

  const slipBuf = Buffer.from(String(data.slipData || ''), 'base64');
  if (!slipBuf.length || slipBuf.length > 6 * 1024 * 1024) return { code: 400, body: { error: 'สลิปไม่ถูกต้องหรือใหญ่เกินไป' } };
  const slipName = String(data.slipName || 'slip.png').replace(/[^\w.\-]/g, '_');

  const orderId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ดึงชื่อผู้ใช้จากบอท (ถ้าได้)
  let memberName = '';
  try {
    const m = await fetch(dcApi(`/guilds/${D.guildId}/members/${discordId}`), { headers: botHeaders() }).then((r) => r.ok ? r.json() : null);
    memberName = m?.nick || m?.user?.global_name || m?.user?.username || '';
  } catch { /* ไม่ได้ก็ข้าม */ }

  const baseOrder = {
    id: orderId, productId: product.id, productName: product.name,
    price, days, roleId: product.roleId, discordId, note: String(data.note || '').slice(0, 300),
    createdAt: Date.now(),
  };

  /* ===== ตรวจสลิปอัตโนมัติ (ถ้าตั้ง EasySlip ไว้) ===== */
  if (AUTO_SLIP) {
    const v = await verifySlip(slipBuf, slipName);
    if (!v.ok) return { code: 400, body: { error: `❌ ${v.error}` } };
    if (v.amount + 0.01 < price) return { code: 400, body: { error: `❌ ยอดโอนไม่พอ (สลิป ฿${v.amount.toLocaleString('th-TH')} ต้อง ฿${price.toLocaleString('th-TH')})` } };
    // กันใช้สลิปซ้ำ
    if (v.transRef) {
      const used = await upstash(['HGET', 'mooni:usedslips', v.transRef]);
      if (used.result) return { code: 400, body: { error: '❌ สลิปนี้ถูกใช้ไปแล้ว' } };
    }

    const ok = await botSetRole(discordId, product.roleId, true);
    if (ok && days) await setRoleExpiry(discordId, product.roleId, Date.now() + days * 86400000);
    if (v.transRef) await upstash(['HSET', 'mooni:usedslips', v.transRef, orderId]);
    await setOrder(orderId, { ...baseOrder, status: ok ? 'approved' : 'failed', auto: true, amount: v.amount, transRef: v.transRef, doneAt: Date.now() });

    // แจ้งเข้าห้องแอดมินเป็น log (ไม่มีปุ่ม)
    if (settings.adminChannelId && muffinToken()) {
      postOrderToDiscord({
        orderId, channelId: settings.adminChannelId, product, price, days, discordId,
        note: `ตรวจสลิปอัตโนมัติ ✅ (ยอด ฿${v.amount})${data.note ? ' · ' + data.note : ''}`,
        slipBuf, slipName, memberName, autoDone: ok ? 'approved' : 'failed',
      }).catch(() => {});
    }
    return ok
      ? { code: 200, body: { ok: true, auto: true } }
      : { code: 200, body: { ok: true, auto: true, roleFailed: true } };
  }

  /* ===== โหมดฟรี: อ่าน QR ในสลิป (กันสลิปซ้ำ + กันภาพมั่ว แต่ไม่เช็คยอด) ===== */
  if (FREE_QR_AVAILABLE && settings.freeVerify !== false) {
    const qr = readSlipQR(slipBuf);
    if (!qr) return { code: 400, body: { error: '❌ อ่าน QR ในสลิปไม่ได้ — กรุณาแคปสลิปโอนเงินเต็มใบจากแอปธนาคาร (ต้องเห็น QR ยืนยันสลิปชัด ๆ)' } };
    const ref = crypto.createHash('sha256').update(qr).digest('hex').slice(0, 24);
    const used = await upstash(['HGET', 'mooni:usedslips', ref]);
    if (used.result) return { code: 400, body: { error: '❌ สลิปนี้ถูกใช้ไปแล้ว' } };

    // เช็คยอดเงินด้วย OCR (อ่านได้ = เทียบ, อ่านไม่ได้ = ปล่อยผ่านไม่บล็อกลูกค้าจริง)
    let ocrAmt = null;
    if (OCR_AVAILABLE && settings.checkAmount !== false) {
      ocrAmt = await ocrAmount(slipBuf);
      if (ocrAmt != null && ocrAmt + 0.01 < price) {
        return { code: 400, body: { error: `❌ ยอดในสลิปไม่พอ (อ่านได้ ฿${ocrAmt.toLocaleString('th-TH')} · ต้อง ฿${price.toLocaleString('th-TH')})` } };
      }
    }

    const ok = await botSetRole(discordId, product.roleId, true);
    if (ok && days) await setRoleExpiry(discordId, product.roleId, Date.now() + days * 86400000);
    await upstash(['HSET', 'mooni:usedslips', ref, orderId]);
    await setOrder(orderId, { ...baseOrder, status: ok ? 'approved' : 'failed', auto: true, freeVerify: true, ocrAmount: ocrAmt, doneAt: Date.now() });

    if (settings.adminChannelId && muffinToken()) {
      const amtNote = ocrAmt != null ? `อ่านยอดได้ ฿${ocrAmt}` : (OCR_AVAILABLE && settings.checkAmount !== false ? 'อ่านยอดไม่ได้ (ปล่อยผ่าน)' : 'ไม่ได้เช็คยอด');
      postOrderToDiscord({
        orderId, channelId: settings.adminChannelId, product, price, days, discordId,
        note: `ตรวจ QR อัตโนมัติ ✅ · ${amtNote}${data.note ? ' · ' + data.note : ''}`,
        slipBuf, slipName, memberName, autoDone: ok ? 'approved' : 'failed',
      }).catch(() => {});
    }
    return ok ? { code: 200, body: { ok: true, auto: true } } : { code: 200, body: { ok: true, auto: true, roleFailed: true } };
  }

  /* ===== ไม่ได้ตั้งอะไร → ส่งให้แอดมินตรวจเอง ===== */
  const post = await postOrderToDiscord({
    orderId, channelId: settings.adminChannelId, product, price, days, discordId,
    note: data.note, slipBuf, slipName, memberName,
  });
  if (!post.ok) return { code: 502, body: { error: `ส่งให้แอดมินไม่สำเร็จ (${post.status || ''}) — เช็คห้อง/สิทธิ์บอท` } };
  await setOrder(orderId, { ...baseOrder, status: 'pending' });
  return { code: 200, body: { ok: true, orderId } };
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
.card{max-width:420px;padding:30px;background:#17141b;border:2px solid rgba(255,255,255,.14);box-shadow:6px 6px 0 #000}
.icon{font-size:46px;margin-bottom:10px}h1{font-size:20px;color:${ok ? '#7ee0a6' : '#ff6b7f'};margin-bottom:10px}
p{font-size:14px;color:#8ea6cc;line-height:1.6}</style></head><body><div class="card">
<div class="icon">${ok ? '✅' : '🔒'}</div><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

/** เรียก Discord API ตรวจว่าคนที่ล็อกอินมียศ Mooni ในเซิร์ฟเวอร์ไหม */
async function checkDiscordMember(accessToken) {
  // ดึง member ของ user เองในเซิร์ฟเวอร์ที่กำหนด — ได้ทั้ง roles และชื่อในครั้งเดียว
  const r = await fetch(`${DC_BASE}/users/@me/guilds/${D.guildId}/member`, {
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
  const { mooni, prime } = appRoles(roles);
  const mc = D.mcRoleId ? roles.includes(D.mcRoleId) : false;   // ยศ Minecraft (ปลดล็อกหน้า Minecraft)
  const candy = D.candyRoleId ? roles.includes(D.candyRoleId) : false;   // ยศ Candy Block (ปลดล็อกการ์ด Candy Block)
  const farmer = D.farmerRoleId ? roles.includes(D.farmerRoleId) : false;   // ยศ Farmer (ปลดล็อกการ์ดแมพ Farmer)
  const diamond = D.diamondRoleId ? roles.includes(D.diamondRoleId) : false;   // ยศ Diamond (ปลดล็อกการ์ด Mooni Diamond)
  const parkour = D.parkourRoleId ? roles.includes(D.parkourRoleId) : false;   // ยศ Parkour (ปลดล็อกการ์ด Parkour V1)
  const parkourv2 = D.parkourv2RoleId ? roles.includes(D.parkourv2RoleId) : false;   // ยศ Parkour V2 (ปลดล็อกการ์ด Parkour V2)
  const speedrun = D.speedrunRoleId ? roles.includes(D.speedrunRoleId) : false;   // ยศ Diamond Speedrun (ปลดล็อกการ์ด Diamond Speedrun)
  const game3d = D.game3dRoleId ? roles.includes(D.game3dRoleId) : false;   // ยศ GAME 3D (ปลดล็อกหน้า GAME 3D)
  // เข้าแอปได้ถ้ามียศ Mooni (รวมยศเต็ม/ยศบางหน้า) "หรือ" ยศ Minecraft "หรือ" ยศ GAME 3D — คนที่ไม่มียศ Mooni เข้าได้เฉพาะหน้าที่มียศ
  const allowed = mooni || mc || game3d;
  return allowed ? { ok: true, name, uid, avatar, prime, mc, candy, farmer, diamond, parkour, parkourv2, speedrun, game3d, mooni, roles } : { ok: false, reason: 'no_role', name, uid };
}

/**
 * ยศใช้แอป (ไม่รวมยศเกม — เกมต้องมียศของเกมนั้นเอง)
 *   ยศเต็ม  (fullRoleId)  = ล็อกอินได้ + ทุกหน้า (รวม Overlay / Spin / Sound)
 *   ยศบางหน้า (basicRoleId) = ล็อกอินได้ + หน้าทั่วไป (Overlay / Spin / Sound ยังล็อก)
 *   ยศ Mooni / Pro เดิมจาก env ยังใช้ได้เหมือนเดิม
 */
function appRoles(roles) {
  const full = !!D.fullRoleId && roles.includes(D.fullRoleId);
  const basic = !!D.basicRoleId && roles.includes(D.basicRoleId);
  const mooni = roles.includes(D.roleId) || basic || full;
  // ยศ Pro จาก env — ถ้าไม่ได้ตั้ง (และไม่มียศบางหน้าแยก) ถือว่าทุกคนที่ล็อกอินได้ = pro เหมือนเดิม
  const envPrime = D.primeRoleId && D.primeRoleId !== D.basicRoleId
    ? roles.includes(D.primeRoleId)
    : !D.primeRoleId && !D.basicRoleId;
  return { mooni, prime: envPrime || full };
}

/** ใช้บอทเช็คยศปัจจุบันของสมาชิก (เรียลไทม์ — ถอดยศแล้วรู้เลย) */
async function botCheckMember(uid) {
  const hit = cacheGet('member:' + uid);
  if (hit) return hit;
  let out;
  try {
    countDcCall();
    const r = await fetch(`${DC_BASE}/guilds/${D.guildId}/members/${uid}`, {
      headers: { Authorization: `Bot ${D.botToken}`, 'User-Agent': DC_UA },
    });
    if (r.status === 404) out = { inGuild: false, mooni: false, prime: false };   // ออกจากเซิร์ฟเวอร์แล้ว
    else if (!r.ok) out = { error: true };
    else {
      const m = await r.json();
      const roles = Array.isArray(m.roles) ? m.roles : [];
      out = {
        inGuild: true,
        ...appRoles(roles),
        mc: D.mcRoleId ? roles.includes(D.mcRoleId) : false,
        candy: D.candyRoleId ? roles.includes(D.candyRoleId) : false,
        farmer: D.farmerRoleId ? roles.includes(D.farmerRoleId) : false,
        diamond: D.diamondRoleId ? roles.includes(D.diamondRoleId) : false,
        parkour: D.parkourRoleId ? roles.includes(D.parkourRoleId) : false,
        parkourv2: D.parkourv2RoleId ? roles.includes(D.parkourv2RoleId) : false,
        speedrun: D.speedrunRoleId ? roles.includes(D.speedrunRoleId) : false,
        game3d: D.game3dRoleId ? roles.includes(D.game3dRoleId) : false,
        name: m.nick || m.user?.global_name || m.user?.username || '',
        roles,
      };
    }
  } catch { out = { error: true }; }
  return cacheSet('member:' + uid, out);
}

/** ใช้บอทเช็คยศใน "ดิสที่สอง" — มียศ role2Id = สิทธิ์ถาวรทุกอย่าง (ข้ามเช็ควันหมดอายุ) */
async function botCheckGuild2(uid) {
  if (!D.botToken || !D.guild2Id || !D.role2Id) return false;
  const hit = cacheGet('guild2:' + uid);
  if (hit !== null) return hit;
  let out = false;
  try {
    countDcCall();
    const r = await fetch(dcApi(`/guilds/${D.guild2Id}/members/${uid}`), {
      headers: { Authorization: `Bot ${D.botToken}`, 'User-Agent': DC_UA },
    });
    if (!r.ok) out = false;   // ไม่อยู่ดิสที่สอง / API มีปัญหา = ถือว่าไม่มีสิทธิ์พิเศษ
    else {
      const m = await r.json();
      const roles = Array.isArray(m.roles) ? m.roles : [];
      out = roles.includes(D.role2Id);
    }
  } catch { out = false; }
  return cacheSet('guild2:' + uid, out);
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

    // ---- ล็อกอินหลังบ้านร้าน (state ขึ้นต้น shopadmin:) ----
    if (pair.startsWith('shopadmin:')) {
      const html = (msg, ok) => resultPage(ok, ok ? 'เข้าหลังบ้านร้านสำเร็จ' : 'เข้าไม่ได้', msg);
      try {
        const tr = await fetch(`${DC_BASE}/oauth2/token`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: D.clientId, client_secret: D.clientSecret, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
        });
        if (!tr.ok) throw new Error('token');
        const tok = await tr.json();
        const mem = await fetch(`${DC_BASE}/users/@me/guilds/${D.guildId}/member`, {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        }).then((r) => r.ok ? r.json() : null);
        const uid = mem?.user?.id;
        if (!uid || !isShopAdminRoles(mem.roles || [])) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(html('บัญชีนี้ไม่มียศแอดมินร้าน', false));
        }
        const cookie = signShopCookie({ uid, exp: Date.now() + 12 * 60 * 60 * 1000 });
        res.writeHead(302, {
          'Set-Cookie': `mooni_shop=${cookie}; HttpOnly; Secure; Path=/; Max-Age=43200; SameSite=Lax`,
          Location: '/shop',
        });
        return res.end();
      } catch {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html('ล็อกอินไม่สำเร็จ ลองใหม่อีกครั้ง', false));
      }
    }

    const rec = authResults.get(pair);
    if (!code || !rec) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage(false, 'ลิงก์หมดอายุ', 'กรุณากดปุ่มล็อกอินในแอปใหม่อีกครั้ง'));
      return true;
    }
    try {
      const tokRes = await fetch(`${DC_BASE}/oauth2/token`, {
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
      let check = await checkDiscordMember(tok.access_token);

      // ไม่อยู่ดิสหลัก / ไม่มียศในดิสหลัก — ยังต้องรู้ uid เพื่อเช็คสิทธิ์ถาวรในดิสที่สอง
      if (!check.uid) {
        try {
          const me = await fetch(`${DC_BASE}/users/@me`, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => (r.ok ? r.json() : null));
          if (me?.id) {
            check = { ...check, uid: me.id, name: check.name || me.global_name || me.username || 'สมาชิก',
              avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : '' };
          }
        } catch { /* ไม่รู้ uid = ไม่มีสิทธิ์ถาวร */ }
      }

      // ดิสที่สอง: มียศ role2Id = สิทธิ์ถาวรทุกอย่าง (ล็อกอิน + ทุกหน้า + ทุกเกม) — ข้ามเช็ควันหมดอายุทั้งหมด
      const permanent = check.uid ? await botCheckGuild2(check.uid) : false;
      // มีสิทธิ์ถาวรแต่ไม่มียศในดิสหลัก (หรือไม่อยู่ดิสหลัก) ก็ล็อกอินได้
      if (permanent && !check.ok) check = { ...check, ok: true, roles: check.roles || [] };

      // เช็ควันหมดอายุจากคลัง (แอดมินตั้งไว้ในเว็บ) — หมดอายุแล้วเข้าไม่ได้แม้มียศ (ยกเว้นสิทธิ์ถาวรจากดิสที่สอง)
      const accessRec = STORE_ENABLED ? await getAccess(check.uid) : null;
      if (check.ok && !permanent && !accessActive(accessRec)) {
        authResults.set(pair, { status: 'denied', reason: 'expired', name: check.name || '', at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultPage(false, 'หมดอายุการใช้งาน', 'สิทธิ์การใช้งานของคุณหมดอายุแล้ว — ทักแอดมินเพื่อต่ออายุ'));
        return true;
      }

      if (check.ok) {
        const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
        // สิทธิ์ถาวร = accessExp 0 (หน้าแอปจะโชว์ "ถาวร")
        const accessExp = permanent ? 0 : (accessRec?.exp || 0);
        // เช็ควันหมดอายุของแต่ละยศ — หมดอายุแล้วถือว่าไม่มียศ
        let roleExpMap = {};
        if (STORE_ENABLED) roleExpMap = await getRoleExpMap();
        const now = Date.now();
        const roleExpired = (roleId) => {
          if (!roleId) return false;
          const roleExp = roleExpMap[`${check.uid}:${roleId}`];
          return roleExp && roleExp <= now;
        };
        // สิทธิ์ถาวรจากดิสที่สอง => ผ่านประตู + ปลดล็อกทุกหน้า/ทุกแมพ ข้ามเช็ควันหมดอายุทุกยศ
        const mooniOk = (!!check.mooni && !roleExpired(D.roleId)) || permanent;
        const mcOk = (!!check.mc && !roleExpired(D.mcRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
        const primeOk = (!!check.prime && !roleExpired(D.primeRoleId)) || permanent;
        const candyOk = (!!check.candy && !roleExpired(D.candyRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
        const farmerOk = (!!check.farmer && !roleExpired(D.farmerRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
        const diamondOk = (!!check.diamond && !roleExpired(D.diamondRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
        const parkourOk = (!!check.parkour && !roleExpired(D.parkourRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
        const parkourv2Ok = (!!check.parkourv2 && !roleExpired(D.parkourv2RoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
        const speedrunOk = (!!check.speedrun && !roleExpired(D.speedrunRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
        const game3dOk = (!!check.game3d && !roleExpired(D.game3dRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
        // ส่งวันหมดอายุของแต่ละยศกลับไปด้วย — แอปเอาไปโชว์บนการ์ดแมพ (เหลืออีกกี่วัน)
        const roleExp = roleExpOf(check.uid, D, roleExpMap);
        const token = signSession({ uid: check.uid, name: check.name, prime: primeOk, mc: mcOk, candy: candyOk, farmer: farmerOk, diamond: diamondOk, parkour: parkourOk, parkourv2: parkourv2Ok, speedrun: speedrunOk, game3d: game3dOk, mooni: mooniOk, exp });
        authResults.set(pair, { status: 'ok', name: check.name, uid: check.uid, avatar: check.avatar || '', prime: primeOk, mc: mcOk, candy: candyOk, farmer: farmerOk, diamond: diamondOk, parkour: parkourOk, parkourv2: parkourv2Ok, speedrun: speedrunOk, game3d: game3dOk, mooni: mooniOk, accessExp, token, exp, roleExp, at: Date.now(), roles: check.roles || [] });
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
    // ดิสที่สอง: มียศ role2Id = สิทธิ์ถาวร — ไม่ถูกเตะเพราะวันหมดอายุ + ปลดล็อกทุกอย่าง
    const permanent = await botCheckGuild2(uid);
    const timeOk = permanent || accessActive(rec);
    const accessExp = permanent ? 0 : (rec?.exp || 0);

    // ไม่ได้ตั้งบอท => เช็คยศสดไม่ได้ แต่ยังเช็ควันหมดอายุได้
    if (!D.botToken) {
      json(200, { valid: timeOk, prime: !!payload.prime, mc: !!payload.mc, candy: !!payload.candy, farmer: !!payload.farmer, diamond: !!payload.diamond, parkour: !!payload.parkour, parkourv2: !!payload.parkourv2, speedrun: !!payload.speedrun, game3d: !!payload.game3d, mooni: !!payload.mooni, accessExp, reason: timeOk ? '' : 'expired', live: false, roleExp: {}, roles: [] });
      return true;
    }
    const chk = await botCheckMember(uid);
    if (chk.error) {   // Discord ล่ม อย่าเพิ่งเตะออก
      json(200, { valid: timeOk, prime: !!payload.prime, mc: !!payload.mc, candy: !!payload.candy, farmer: !!payload.farmer, diamond: !!payload.diamond, parkour: !!payload.parkour, parkourv2: !!payload.parkourv2, speedrun: !!payload.speedrun, game3d: !!payload.game3d, mooni: !!payload.mooni, accessExp, reason: timeOk ? '' : 'expired', live: false, roleExp: {}, roles: [] });
      return true;
    }
    // เช็ควันหมดอายุของแต่ละยศ — หมดอายุแล้วถือว่าไม่มียศ
    let roleExpMap = {};
    if (STORE_ENABLED) roleExpMap = await getRoleExpMap();
    const now = Date.now();
    const roleExpired = (roleId) => {
      if (!roleId) return false;
      const exp = roleExpMap[`${uid}:${roleId}`];
      return exp && exp <= now;
    };
    // สิทธิ์ถาวรจากดิสที่สอง => ผ่าน + ปลดล็อกทุกหน้า/ทุกแมพ ข้ามเช็ควันหมดอายุทุกยศ
    const mooniOk = (!!chk.mooni && !roleExpired(D.roleId)) || permanent;
    const mcOk = (!!chk.mc && !roleExpired(D.mcRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
    const primeOk = (!!chk.prime && !roleExpired(D.primeRoleId)) || permanent;
    const candyOk = (!!chk.candy && !roleExpired(D.candyRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
    const farmerOk = (!!chk.farmer && !roleExpired(D.farmerRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
    const diamondOk = (!!chk.diamond && !roleExpired(D.diamondRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
    const parkourOk = (!!chk.parkour && !roleExpired(D.parkourRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
    const parkourv2Ok = (!!chk.parkourv2 && !roleExpired(D.parkourv2RoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
    const speedrunOk = (!!chk.speedrun && !roleExpired(D.speedrunRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
    const game3dOk = (!!chk.game3d && !roleExpired(D.game3dRoleId)) || permanent;   // ยศเกมของมันเอง หรือสิทธิ์ถาวร (ดิสที่สอง) — ยศแอปอื่นไม่ปลดล็อก
    // ยังใช้แอปได้ถ้ายังมียศ Mooni / Minecraft / GAME 3D อย่างใดอย่างหนึ่ง
    const valid = (mooniOk || mcOk || game3dOk) && timeOk;
    const reason = (!mooniOk && !mcOk && !game3dOk) ? 'no_role' : !timeOk ? 'expired' : '';
    json(200, { valid, prime: primeOk, mc: mcOk, candy: candyOk, farmer: farmerOk, diamond: diamondOk, parkour: parkourOk, parkourv2: parkourv2Ok, speedrun: speedrunOk, game3d: game3dOk, mooni: mooniOk, accessExp, name: chk.name, live: true, reason, roleExp: roleExpOf(uid, D, roleExpMap), roles: chk.roles || [] });
    return true;
  }

  // แอปคอยถามผลล็อกอิน
  if (url.pathname === '/auth/status') {
    const pair = url.searchParams.get('pair') || '';
    const rec = authResults.get(pair);
    if (!rec) { json(200, { status: 'unknown' }); return true; }
    if (rec.status === 'ok') {
      json(200, { status: 'ok', name: rec.name, uid: rec.uid, avatar: rec.avatar || '', prime: !!rec.prime, mc: !!rec.mc, candy: !!rec.candy, farmer: !!rec.farmer, diamond: !!rec.diamond, parkour: !!rec.parkour, parkourv2: !!rec.parkourv2, speedrun: !!rec.speedrun, game3d: !!rec.game3d, mooni: !!rec.mooni, accessExp: rec.accessExp || 0, token: rec.token, exp: rec.exp, roleExp: rec.roleExp || {}, roles: rec.roles || [] });
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
  .card{width:100%;max-width:460px;padding:26px;background:#17141b;border:2px solid rgba(255,255,255,.14);box-shadow:6px 6px 0 #000}
  h1{font-size:19px;font-weight:800;margin-bottom:4px;color:#ff7ab8}
  p.sub{font-size:13px;color:#8ea6cc;margin-bottom:18px}
  label{display:block;font-size:12.5px;font-weight:600;color:#8ea6cc;margin:14px 0 8px}
  input,textarea{width:100%;padding:12px 14px;background:#0a0a0c;color:#fdeef5;border:2px solid rgba(255,255,255,.14);font:inherit;font-size:15px}
  textarea{min-height:96px;resize:vertical}
  input:focus,textarea:focus{outline:none;border-color:#ff7ab8}
  .count{text-align:right;font-size:11.5px;color:#8ea6cc;margin-top:6px}
  button{width:100%;margin-top:16px;padding:14px;background:linear-gradient(100deg,#d64f92,#ff7ab8);
    color:#2a0f1c;border:2px solid #000;box-shadow:3px 3px 0 #000;font:inherit;font-size:16px;font-weight:800;cursor:pointer;
    transition:transform .08s,box-shadow .08s}
  button:hover{transform:translate(-2px,-2px);box-shadow:5px 5px 0 #000}
  button:active{transform:translate(2px,2px);box-shadow:0 0 0 #000}
  button:disabled{opacity:.5;cursor:default}
  .status{margin-top:14px;font-size:13px;text-align:center;min-height:20px}
  .status.ok{color:#ff7ab8}.status.err{color:#ff6b7f}
  .online{margin-top:10px;font-size:12px;color:#8ea6cc;text-align:center}
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
/* หน้าแอดมินจัดการสมาชิก — แยกเป็นไฟล์ panel.html (แก้ง่าย) แล้วบีบอัด gzip ไว้ตั้งแต่เปิดเซิร์ฟเวอร์ */
const PANEL_HTML = fs.readFileSync(require('path').join(__dirname, 'panel.html'), 'utf8');
const PANEL_GZ = require('zlib').gzipSync(PANEL_HTML);

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
      createTicket(body, staffRoleId, categoryId).catch((err) => {
        console.error('[ticket] เปิดห้องไม่สำเร็จ:', err.message);
        return editOriginal(
          body.application_id,
          body.token,
          'เปิดห้อง Ticket ไม่สำเร็จชั่วคราว กรุณาลองใหม่อีกครั้ง หรือติดต่อทีมงาน',
        );
      });
      return;
    }

    if (customId.startsWith('tk:d:') || customId.startsWith('tk:c:')) {
      const staffIds = String(customId.split(':')[2] || '').split(',').filter(Boolean);
      const roles = body.member?.roles || [];
      // คนเปิดห้อง (ไม่มียศทีมงาน) กดไม่ได้
      if (!isTicketStaff(roles, staffIds)) return reply('❌ ปุ่มนี้ใช้ได้เฉพาะทีมงานเท่านั้น');

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
        closeTicketFlow({
          deleteChannel: async () => {
            const deleted = await ticketRequest(`/channels/${chId}`, {
              method: 'DELETE', headers: hdr(token), signal: AbortSignal.timeout(8000),
            });
            if (deleted.ok) return;
            const detail = await deleted.json().catch(() => ({}));
            throw new Error(`Discord ${deleted.status}: ${detail?.message || 'ลบห้องไม่สำเร็จ'}`);
          },
          announceFailure: (content) => editOriginal(body.application_id, body.token, content),
        }).catch((err) => console.error('[ticket] ปิดห้องไม่สำเร็จ:', err.message));
      }, 3000);
      return;
    }

    /* ---- ร้านค้า: อนุมัติ / ปฏิเสธ คำสั่งซื้อ ---- */
    if (customId.startsWith('sh:a:') || customId.startsWith('sh:r:')) {
      const approve = customId.startsWith('sh:a:');
      const orderId = customId.slice(5);
      const roles = body.member?.roles || [];
      if (!isTicketStaff(roles, []) && !isShopAdminRoles(roles)) return reply('❌ ปุ่มนี้ใช้ได้เฉพาะทีมงานเท่านั้น');

      json({ type: 5 });                                   // deferred (ทุกคนเห็น)
      (async () => {
        const appId = body.application_id, itoken = body.token;
        const order = await getOrder(orderId);
        if (!order) return editOriginal(appId, itoken, `ไม่พบคำสั่งซื้อ \`${orderId}\``);
        if (order.status !== 'pending') {
          return editOriginal(appId, itoken, `คำสั่งซื้อนี้ถูกจัดการไปแล้ว (${order.status})`);
        }

        const by = body.member?.user?.id;
        if (!approve) {
          await setOrder(orderId, { ...order, status: 'rejected', by, doneAt: Date.now() });
          return editOriginal(appId, itoken, `❌ <@${by}> **ปฏิเสธ** คำสั่งซื้อของ <@${order.discordId}> แล้ว`);
        }

        const ok = await botSetRole(order.discordId, order.roleId, true);
        if (ok && order.days) await setRoleExpiry(order.discordId, order.roleId, Date.now() + order.days * 86400000);
        await setOrder(orderId, { ...order, status: ok ? 'approved' : 'failed', by, doneAt: Date.now() });
        return editOriginal(appId, itoken, ok
          ? `✅ <@${by}> **อนุมัติ** แล้ว — <@${order.discordId}> ได้รับยศ <@&${order.roleId}>${order.days ? ` (${order.days} วัน)` : ''} เรียบร้อย`
          : `⚠️ อนุมัติแล้วแต่ **ให้ยศไม่สำเร็จ** — เช็คสิทธิ์ Manage Roles และลำดับยศบอท`);
      })().catch(() => {});
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
  if (!ADMIN_KEY) return { code: 503, body: { error: 'ADMIN_KEY is not configured' } };
  if (data.key !== ADMIN_KEY) return { code: 401, body: { error: 'รหัสผ่านไม่ถูกต้อง' } };
  if (!D.botToken) return { code: 400, body: { error: 'ยังไม่ได้ตั้งบอท (DISCORD_BOT_TOKEN)' } };

  if (pathname === '/panel/members') {
    if (data.fresh) dcCache.delete('members:all');   // ปุ่มรีเฟรช = ดึงจากดิสคอร์ดใหม่จริง
    const [listRes, maps] = await Promise.all([botListMembers(), panelLoadMaps(!!data.fresh)]);
    const list = listRes.members || [];
    const members = list.map((m) => panelMember(m, maps));
    // เรียง: ออนไลน์ก่อน แล้วตามชื่อ
    members.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    // บอกด้วยว่าถ้ารายชื่อว่างเพราะติดต่อดิสไม่ได้ (เดิมเงียบ ทำให้ดูเหมือนข้อมูลหาย)
    const warning = listRes.ok
      ? (list.length ? '' : 'ติดต่อดิสคอร์ดได้แต่ไม่พบสมาชิก — เช็คว่าบอทอยู่ในเซิร์ฟเวอร์ที่ตั้งไว้จริง')
      : ('เชื่อมดิสคอร์ดไม่ได้: ' + dcErrText(listRes) + (listRes.hint ? ' | ' + listRes.hint : ''));
    return {
      code: 200,
      body: {
        members, discordOk: !!listRes.ok, discordCount: listRes.count || 0, warning,
        storeCounts: { access: Object.keys(maps.access || {}).length, roleExp: Object.keys(maps.roleExp || {}).length },
      },
    };
  }

  /* ---------- ตรวจระบบ: บอกว่าติดตรงไหน (บอท · ดิสคอร์ด · ที่เก็บข้อมูล) ---------- */
  if (pathname === '/panel/diag') {
    const checks = [];
    const add = (ok, label, msg) => checks.push({ ok: !!ok, label, msg: msg || '' });

    // 1) env ที่ตั้งไว้ + ค่าที่ถูกทำความสะอาด
    const envKeys = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_GUILD_ID', 'DISCORD_ROLE_ID', 'DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'MUFFIN_BOT_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'AUTH_SECRET', 'ADMIN_KEY'];
    const missing = envKeys.filter((k) => !String(process.env[k] || '').trim());
    add(!missing.length, 'ค่าตั้งต้น (env)',
      (missing.length ? 'ยังไม่ได้ตั้ง: ' + missing.join(', ') : 'ตั้งครบทั้ง ' + envKeys.length + ' ตัว')
      + (ENV_FIXED.length ? ' · แก้ช่องว่าง/อัญประกาศให้แล้ว: ' + ENV_FIXED.join(', ') : ''));

    // 2) ที่เก็บข้อมูลถาวร
    let accessCount = 0, roleExpCount = 0;
    if (!STORE_ENABLED) {
      add(false, 'ที่เก็บข้อมูล Upstash', 'ยังไม่ได้ตั้ง UPSTASH_REDIS_REST_URL / TOKEN — วันหมดอายุจะไม่ถูกจำ');
    } else {
      const [am, rm] = await Promise.all([getAccessMap(), getRoleExpMap()]);
      accessCount = Object.keys(am).length;
      roleExpCount = Object.keys(rm).length;
      const w = await upstash(['SET', 'mooni:selftest', String(Date.now())]);
      const r = await upstash(['GET', 'mooni:selftest']);
      await upstash(['DEL', 'mooni:selftest']);
      const bad = w?.error || r?.error;
      add(!bad, 'ที่เก็บข้อมูล Upstash', bad
        ? ('เชื่อมไม่ได้: ' + bad)
        : ('เขียน/อ่านได้ · ข้อมูลที่เก็บอยู่: สิทธิ์ใช้แอป ' + accessCount + ' รายการ · วันหมดอายุยศ ' + roleExpCount + ' รายการ'));
    }

    // 3) บอท Mooni ล็อกอิน
    const me = await dcFetch('/users/@me');
    add(me.ok, 'บอท Mooni ล็อกอิน', !D.botToken ? 'ยังไม่ได้ตั้ง DISCORD_BOT_TOKEN'
      : me.ok ? ('บัญชี ' + me.data.username + ' (id ' + me.data.id + ')')
      : (dcErrText(me) + ' | ' + dcHint(me.status, me.code)));

    // 4) เซิร์ฟเวอร์หลัก + ดิสที่สอง
    const g1 = await dcFetch(`/guilds/${D.guildId}`);
    add(g1.ok, 'เซิร์ฟเวอร์หลัก', !D.guildId ? 'ยังไม่ได้ตั้ง DISCORD_GUILD_ID'
      : g1.ok ? (g1.data.name + ' (id ' + g1.data.id + ')')
      : (dcErrText(g1) + ' | ' + dcHint(g1.status, g1.code)));
    const g2 = await dcFetch(`/guilds/${D.guild2Id}`);
    add(g2.ok, 'ดิสที่สอง (สิทธิ์ถาวร)', g2.ok ? (g2.data.name + ' (id ' + g2.data.id + ')')
      : (dcErrText(g2) + ' | ' + dcHint(g2.status, g2.code)));

    // 5) สิทธิ์บอท + ยศที่บอทให้ไม่ได้
    const rolesRes = await dcFetch(`/guilds/${D.guildId}/roles`);
    const gRoles = Array.isArray(rolesRes.data) ? rolesRes.data : [];
    const meMember = me.ok ? await dcFetch(`/guilds/${D.guildId}/members/${me.data.id}`) : { ok: false, data: null };
    const myRoles = Array.isArray(meMember.data?.roles) ? meMember.data.roles : [];
    const bits = gRoles.reduce((acc, r) => ((myRoles.includes(r.id) || r.id === D.guildId) ? acc | BigInt(r.permissions || 0) : acc), 0n);
    const isAdmin = (bits & 8n) === 8n;
    const canRoles = isAdmin || (bits & 268435456n) === 268435456n;
    const canChannels = isAdmin || (bits & 16n) === 16n;
    const myTop = gRoles.filter((r) => myRoles.includes(r.id)).reduce((m, r) => Math.max(m, r.position || 0), 0);
    const managed = [['Mooni', D.roleId], ['Mooni Pro', D.primeRoleId], ['Minecraft', D.mcRoleId], ['Candy', D.candyRoleId], ['Farmer', D.farmerRoleId], ['Diamond', D.diamondRoleId], ['Parkour', D.parkourRoleId], ['Parkour V2', D.parkourv2RoleId], ['Speedrun', D.speedrunRoleId], ['GAME 3D', D.game3dRoleId]].filter(([, id]) => id);
    const notFound = managed.filter(([, id]) => !gRoles.some((r) => r.id === id)).map(([n]) => n);
    const under = managed.filter(([, id]) => { const r = gRoles.find((x) => x.id === id); return r && (r.position || 0) >= myTop; }).map(([n]) => n);
    add(rolesRes.ok && canRoles && canChannels && !under.length && !notFound.length, 'สิทธิ์บอท + ลำดับยศ',
      !rolesRes.ok ? ('ตรวจไม่ได้: ' + dcErrText(rolesRes)) :
      (canRoles ? 'Manage Roles ✓' : 'Manage Roles ✗') + ' · ' + (canChannels ? 'Manage Channels ✓' : 'Manage Channels ✗')
      + (under.length ? ' · ยศที่บอทให้ไม่ได้ (ยศบอทอยู่ต่ำกว่า): ' + under.join(', ') : '')
      + (notFound.length ? ' · ไม่พบยศนี้ในเซิร์ฟเวอร์: ' + notFound.join(', ') : ''));

    // 6) ดึงรายชื่อสมาชิก (ต้องเปิด Server Members Intent)
    const mem = await dcFetch(`/guilds/${D.guildId}/members?limit=1`);
    add(mem.ok, 'ดึงรายชื่อสมาชิก', mem.ok
      ? ('ได้ ' + (Array.isArray(mem.data) ? mem.data.length : 0) + ' รายการ (ทดสอบ 1 รายการ)')
      : (dcErrText(mem) + ' | ' + dcHint(mem.status, mem.code)));

    // 7) บอท Muffin (ticket) + ห้อง/หมวดหมู่ที่ใช้
    if (M.botToken) {
      const mm = await dcFetch('/users/@me', { token: M.botToken });
      const inGuild = mm.ok ? await dcFetch(`/guilds/${D.guildId}/members/${mm.data.id}`, { token: M.botToken }) : { ok: false, status: mm.status, code: mm.code, error: mm.error };
      add(mm.ok && inGuild.ok, 'บอท Muffin (ticket)', !mm.ok
        ? (dcErrText(mm) + ' | ' + dcHint(mm.status, mm.code))
        : inGuild.ok ? ('บัญชี ' + mm.data.username + ' · อยู่ในเซิร์ฟเวอร์ ✓')
        : ('ไม่อยู่ในเซิร์ฟเวอร์/ไม่มีสิทธิ์: ' + dcErrText(inGuild) + ' | ' + dcHint(inGuild.status, inGuild.code)));
    } else {
      add(true, 'บอท Muffin (ticket)', 'ไม่ได้ตั้ง MUFFIN_BOT_TOKEN — ใช้บอท Mooni ตัวเดิม' );
    }
    // 8) บอท Uplimit Media (ต้อนรับ + Ticket ของเซิร์ฟเวอร์ Uplimit) — รันอยู่ในโปรเซสนี้
    const ul = uplimit.status();
    if (!ul.enabled) {
      add(true, 'บอท Uplimit Media', 'ปิดอยู่ — ไม่ได้ตั้ง UPLIMIT_TOKEN / UPLIMIT_GUILD_ID');
    } else if (ul.online) {
      add(true, 'บอท Uplimit Media', 'ออนไลน์ ' + ul.tag + ' · ' + ul.guild);
    } else {
      add(false, 'บอท Uplimit Media', 'ต่อไม่ติด: ' + (ul.error || 'ยังไม่ล็อกอิน')
        + ' — ตรวจ UPLIMIT_TOKEN กับ SERVER MEMBERS INTENT ของแอป Uplimit');
    }

    const tkCh = String(data.ticketChannel || '').trim();
    const tkCat = String(data.ticketCategory || '').trim();
    if (/^\d{5,}$/.test(tkCh)) {
      const c = await dcFetch('/channels/' + tkCh, { token: muffinToken() });
      add(c.ok, 'ห้องวางปุ่ม Ticket', c.ok ? ('#' + (c.data.name || tkCh)) : (dcErrText(c) + ' | ' + dcHint(c.status, c.code)));
    }
    if (/^\d{5,}$/.test(tkCat)) {
      const c = await dcFetch('/channels/' + tkCat, { token: muffinToken() });
      add(c.ok, 'หมวดหมู่สร้างห้อง Ticket', c.ok ? (c.data.name || tkCat) : (dcErrText(c) + ' | ' + dcHint(c.status, c.code)));
    }

    // 8) ลิงก์ชวนเข้าเซิร์ฟเวอร์ (ใช้ได้อยู่ไหม — เช็คได้โดยไม่ต้องมีโทเคน)
    if (D.invite) {
      const code = (D.invite.match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/) || [])[1];
      if (!code) {
        add(false, 'ลิงก์ชวนเข้าเซิร์ฟเวอร์', 'รูปแบบไม่ถูกต้อง: ' + D.invite);
      } else {
        let inv = { ok: false, status: 0, code: 0, error: '', data: null };
        try {
          const r = await fetch(`${DC_BASE}/v10/invites/` + code + '?with_counts=true');
          inv.status = r.status;
          inv.ok = r.ok;
          inv.data = await r.json().catch(() => null);
          if (!r.ok) { inv.code = inv.data?.code || 0; inv.error = inv.data?.message || ('HTTP ' + r.status); }
        } catch (e) { inv.error = 'network: ' + (e?.message || e); }
        add(inv.ok, 'ลิงก์ชวนเข้าเซิร์ฟเวอร์', inv.ok
          ? ('ใช้ได้ · เซิร์ฟเวอร์ ' + (inv.data.guild?.name || '?') + ' (id ' + (inv.data.guild?.id || '?') + ') · สมาชิก ~' + (inv.data.approximate_member_count || '?'))
          : (dcErrText(inv) + ' — สร้างลิงก์ชวนใหม่แล้วตั้งค่า DISCORD_INVITE (ถ้าขึ้น Unknown Invite แปลว่าเซิร์ฟเวอร์ถูกลบไปแล้ว)'));
      }
    } else {
      add(true, 'ลิงก์ชวนเข้าเซิร์ฟเวอร์', 'ไม่ได้ตั้ง DISCORD_INVITE');
    }

    // 9) คีย์ตรวจลายเซ็นปุ่มในดิส
    add(!!D.publicKey && D.publicKey.length === 64, 'Public key (ปุ่มในดิส)', D.publicKey
      ? ('ความยาว ' + D.publicKey.length + ' ตัวอักษร (ต้องได้ 64)')
      : 'ยังไม่ได้ตั้ง DISCORD_PUBLIC_KEY — กดปุ่มในดิสแล้วจะไม่ตอบ');

    return { code: 200, body: { checks, envFixed: ENV_FIXED, storeCounts: { access: accessCount, roleExp: roleExpCount } } };
  }

  if (pathname === '/panel/role') {
    const roleId = data.role === 'prime' ? D.primeRoleId : data.role === 'mc' ? D.mcRoleId : data.role === 'candy' ? D.candyRoleId : data.role === 'farmer' ? D.farmerRoleId : data.role === 'diamond' ? D.diamondRoleId : data.role === 'parkour' ? D.parkourRoleId : data.role === 'parkourv2' ? D.parkourv2RoleId : data.role === 'speedrun' ? D.speedrunRoleId : data.role === 'game3d' ? D.game3dRoleId : D.roleId;
    if (!roleId) return { code: 400, body: { error: 'ยังไม่ได้ตั้งไอดียศนี้' } };
    const roleRes = await botSetRoleDetail(String(data.uid), roleId, !!data.on);
    const ok = roleRes.ok;
    if (!ok) {
      return {
        code: 500,
        body: { error: 'ให้ยศไม่สำเร็จ: ' + dcErrText(roleRes) + (roleRes.hint ? ' | ' + roleRes.hint : '') },
      };
    }
    // ถอดยศ = ล้างวันหมดอายุที่ตั้งไว้ด้วย (กันกวาดซ้ำ)
    if (ok && !data.on && STORE_ENABLED) await delRoleExpiry(String(data.uid), roleId);
    return { code: ok ? 200 : 500, body: ok ? { ok: true, member: await panelMemberOf(data.uid) } : { error: 'บอทกดยศไม่สำเร็จ (เช็คสิทธิ์ Manage Roles + ลำดับยศ)' } };
  }

  // ตั้ง/ล้างวันหมดอายุของยศ (หมดแล้วบอทถอดยศเองตอนกวาดทุก 5 นาที)
  // รองรับทั้ง mcexpiry (เดิม) และ roleexpiry (ใหม่ รองรับทุกยศ)
  if (pathname === '/panel/mcexpiry' || pathname === '/panel/roleexpiry') {
    if (!STORE_ENABLED) return { code: 400, body: { error: 'ยังไม่ได้ตั้ง Upstash' } };
    // หา roleId จาก role name หรือใช้ mcRoleId เดิม
    const roleParam = data.role || 'mc';
    const roleIdMap = { mc: D.mcRoleId, mooni: D.roleId, prime: D.primeRoleId, candy: D.candyRoleId, farmer: D.farmerRoleId, diamond: D.diamondRoleId, parkour: D.parkourRoleId, parkourv2: D.parkourv2RoleId, speedrun: D.speedrunRoleId, game3d: D.game3dRoleId };
    const roleId = roleIdMap[roleParam];
    if (!roleId) return { code: 400, body: { error: 'ยังไม่ได้ตั้งไอดียศ ' + roleParam } };
    const uid = String(data.uid);
    const exp = Number(data.exp) || 0;
    const now = Date.now();
    if (exp && exp <= now) {                    // เอาออกเดี๋ยวนี้
      await botSetRole(uid, roleId, false);
      await delRoleExpiry(uid, roleId);
    } else if (exp === 0) {                      // ถาวร — ให้ยศไว้ ไม่มีวันหมด
      await botSetRole(uid, roleId, true);
      await delRoleExpiry(uid, roleId);
    } else {                                     // ตั้งวันหมดอายุ — ให้ยศ + ตั้งเวลาถอด
      await botSetRole(uid, roleId, true);
      await setRoleExpiry(uid, roleId, exp);
    }
    return { code: 200, body: { ok: true, member: await panelMemberOf(uid) } };
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
    // ยศทีมงานใส่ได้หลายอัน คั่นด้วยจุลภาค
    const staffRoleId = String(data.staffRoleId || '').split(',').map((s) => s.trim()).filter(Boolean).join(',');
    const categoryId = String(data.categoryId || '').trim();
    if (!/^\d{5,}$/.test(channelId)) return { code: 400, body: { error: 'ไอดีห้องไม่ถูกต้อง' } };
    if (!/^\d{5,}$/.test(categoryId)) return { code: 400, body: { error: 'ไอดีหมวดหมู่ไม่ถูกต้อง' } };
    if (!staffRoleId || !staffRoleId.split(',').every((r) => /^\d{5,}$/.test(r))) {
      return { code: 400, body: { error: 'ไอดียศทีมงานไม่ถูกต้อง (หลายยศคั่นด้วย ,)' } };
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
    return { code: 200, body: { ok: true, member: await panelMemberOf(data.uid) } };
  }

  /* ---------- จัดการร้านค้า (ใช้ตัวกลาง doShopAdmin) ---------- */
  if (pathname === '/panel/shop/get') return doShopAdmin('get', data);
  if (pathname === '/panel/shop/settings') return doShopAdmin('settings', data);
  if (pathname === '/panel/shop/product') return doShopAdmin('product', data);
  if (pathname === '/panel/shop/delproduct') {
    return doShopAdmin('delproduct', data);
  }

  return { code: 404, body: { error: 'not found' } };
}

async function bloxgateAvatarUrl(userId) {
  try {
    const response = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=150x150&format=Png&isCircular=false`);
    const avatar = (await response.json())?.data?.[0]?.imageUrl;
    return typeof avatar === 'string' ? avatar : null;
  } catch {
    return null;
  }
}

async function bloxgateGameProfile(universeId, fallbackName) {
  const profile = { name: fallbackName, iconUrl: null };
  if (!/^\d+$/.test(String(universeId)) || Number(universeId) < 1) return profile;
  const encodedId = encodeURIComponent(universeId);
  const [gameResult, iconResult] = await Promise.allSettled([
    fetch(`https://games.roblox.com/v1/games?universeIds=${encodedId}`),
    fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${encodedId}&size=512x512&format=Png&isCircular=false`),
  ]);
  if (gameResult.status === 'fulfilled') {
    try { profile.name = (await gameResult.value.json())?.data?.[0]?.name || profile.name; } catch {}
  }
  if (iconResult.status === 'fulfilled') {
    try { profile.iconUrl = (await iconResult.value.json())?.data?.[0]?.imageUrl || null; } catch {}
  }
  return profile;
}

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/bloxgate/login') {
    return readJson(req).then((data) => {
      if (!BLOXGATE_ADMIN_PASSWORD) return { code: 503, body: { error: 'BLOXGATE_ADMIN_PASSWORD is not configured' } };
      if (String(data.username || '') !== BLOXGATE_ADMIN_USERNAME || String(data.password || '') !== BLOXGATE_ADMIN_PASSWORD) return { code: 401, body: { error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' } };
      const session = crypto.createHmac('sha256', AUTH_SECRET).update(`bloxgate:${BLOXGATE_ADMIN_USERNAME}`).digest('hex');
      return { code: 200, body: { ok: true }, cookie: `bloxgate_admin=${session}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict` };
    }).then((out) => { res.writeHead(out.code, { 'Content-Type': 'application/json', ...(out.cookie ? { 'Set-Cookie': out.cookie } : {}) }); res.end(JSON.stringify(out.body)); })
      .catch(() => { res.writeHead(400); res.end('{"error":"Invalid login request"}'); });
  }

  // ---- Bloxgate Roblox API: เกมลงทะเบียนตัวเอง แล้วตรวจสิทธิ์ด้วย key ที่เก็บใน Render ----
  if (req.method === 'POST' && (url.pathname === '/api/roblox/register' || url.pathname === '/api/roblox/access')) {
    readJson(req).then(async (data) => {
      const headers = { 'Content-Type': 'application/json', ...cors };
      if (!BLOXGATE_API_KEY) return { code: 503, body: { ok: false, error: 'BLOXGATE_API_KEY is not configured' } };
      if (!isBloxgateRequest(req.headers, BLOXGATE_API_KEY)) return { code: 401, body: { ok: false, error: 'Unauthorized Roblox server' } };
      if (!STORE_ENABLED) return { code: 503, body: { ok: false, error: 'Bloxgate storage is not configured' } };
      const placeId = String(data.placeId || '').trim();
      const gameName = String(data.gameName || '').trim().slice(0, 80);
      if (!/^\d+$/.test(placeId) || Number(placeId) < 1 || !gameName) return { code: 400, body: { ok: false, error: 'Invalid game identity' } };
      if (url.pathname === '/api/roblox/register') {
        const universeId = String(data.universeId || '').trim();
        const profile = await bloxgateGameProfile(universeId, gameName);
        const maps = await bloxgateRead(bloxgateMapKey, {});
        maps[placeId] = { placeId, universeId: /^\d+$/.test(universeId) ? universeId : null, name: profile.name, iconUrl: profile.iconUrl, updatedAt: Date.now() };
        await bloxgateWrite(bloxgateMapKey, maps);
        return { code: 200, body: { ok: true, map: maps[placeId] } };
      }
      const userId = String(data.userId || '').trim();
      if (!/^\d+$/.test(userId) || Number(userId) < 1) return { code: 400, body: { ok: false, error: 'Invalid Roblox user ID' } };
      const grants = await bloxgateRead(bloxgateGrantKey(placeId), {});
      if (removeExpiredGrants(grants)) await bloxgateWrite(bloxgateGrantKey(placeId), grants);
      return { code: 200, body: { ok: true, ...accessForUser(grants, userId) } };
    }).then((out) => { res.writeHead(out.code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(out.body)); })
      .catch(() => { try { res.writeHead(500, cors); res.end(JSON.stringify({ ok: false, error: 'Bloxgate request failed' })); } catch {} });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/roblox/maps') {
    return bloxgateRead(bloxgateMapKey, {}).then((maps) => {
      const list = Object.values(maps).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ ok: true, maps: list }));
    }).catch(() => { res.writeHead(500, cors); res.end('{"ok":false}'); });
  }

  if (url.pathname === '/api/roblox/grants' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
    readJson(req).then(async (data) => {
      const headers = { 'Content-Type': 'application/json', ...cors };
      if (!BLOXGATE_API_KEY) return { code: 503, body: { error: 'BLOXGATE_API_KEY is not configured' } };
      if (!isBloxgateRequest(req.headers, BLOXGATE_API_KEY) && !hasBloxgateAdminAccess(req.headers)) return { code: 401, body: { error: 'Unauthorized Bloxgate admin' } };
      if (!STORE_ENABLED) return { code: 503, body: { error: 'Bloxgate storage is not configured' } };
      const placeId = String(url.searchParams.get('placeId') || data.placeId || '').trim();
      if (!/^\d+$/.test(placeId)) return { code: 400, body: { error: 'Invalid Place ID' } };
      const grants = await bloxgateRead(bloxgateGrantKey(placeId), {});
      if (req.method === 'GET') {
        let changed = removeExpiredGrants(grants);
        const rows = await Promise.all(Object.entries(grants).map(async ([userId, grant]) => {
          if (grant.avatarUrl) return grant;
          const avatarUrl = await bloxgateAvatarUrl(grant.robloxUserId || grant.id || userId);
          if (avatarUrl) { grant.avatarUrl = avatarUrl; changed = true; }
          return grant;
        }));
        if (changed) await bloxgateWrite(bloxgateGrantKey(placeId), grants);
        return { code: 200, body: { grants: rows } };
      }
      if (req.method === 'DELETE') {
        const userId = String(url.searchParams.get('userId') || data.userId || '').trim();
        delete grants[userId]; await bloxgateWrite(bloxgateGrantKey(placeId), grants);
        return { code: 200, body: { deleted: true } };
      }
      const username = String(data.username || '').trim();
      if (!username) return { code: 400, body: { error: 'Roblox username is required' } };
      const lookup = await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }) });
      const user = (await lookup.json())?.data?.[0];
      if (!user) return { code: 400, body: { error: 'Roblox username was not found' } };
      const isPermanent = data.isPermanent === true;
      const expiresAt = isPermanent ? null : new Date(data.expiresAt).toISOString();
      if (!isPermanent && Number.isNaN(Date.parse(expiresAt))) return { code: 400, body: { error: 'Expiry must be valid' } };
      const avatarUrl = await bloxgateAvatarUrl(user.id);
      const grant = { id: Number(user.id), robloxUserId: Number(user.id), username: user.name, displayName: user.displayName, avatarUrl, presenceType: 0, isPermanent, expiresAt };
      grants[String(user.id)] = grant; await bloxgateWrite(bloxgateGrantKey(placeId), grants);
      return { code: 201, body: { grant } };
    }).then((out) => { res.writeHead(out.code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(out.body)); })
      .catch(() => { try { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'Bloxgate request failed' })); } catch {} });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(BLOXGATE_ADMIN_HTML);
  }

  if (req.method === 'GET' && url.pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(ADMIN_HTML);
  }

  // เช็คสถานะ (โฮสต์บางที่ใช้ ping ให้ไม่หลับ)
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, clients: wss.clients.size, authEnabled: AUTH_ENABLED,
      bot: !!D.botToken, store: STORE_ENABLED, dcCalls, roleWatch: roleWatchStatus(),
      publicKey: !!D.publicKey, publicKeyLen: D.publicKey.length,
      muffinToken: !!M.botToken, muffinKey: !!M.publicKey, muffinKeyLen: M.publicKey.length,
      autoSlip: AUTO_SLIP, freeQr: FREE_QR_AVAILABLE, ocr: OCR_AVAILABLE,
      discord: discordHealth,   // สถานะล่าสุดที่ relay คุยกับดิสคอร์ดได้ (ไม่มีข้อมูลลับ)
      uplimit: uplimit.status(),   // บอท Uplimit Media ที่รันอยู่ในโปรเซสนี้ (ไม่มีข้อมูลลับ)
      customApiBase: !!DC_CUSTOM_BASE,   // ยิงผ่านพร็อกซี่อยู่ไหม (ไม่โชว์ URL/รหัส)
    }));
  }

  // เทียบ public key ที่ตั้งไว้กับในหน้า Developer Portal (public key ไม่ใช่ความลับ)
  if (process.env.RELAY_DEBUG === '1' && req.method === 'GET' && url.pathname === '/debug/keys') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      mooniPublicKey: D.publicKey || '(ยังไม่ตั้ง)',
      muffinPublicKey: M.publicKey || '(ยังไม่ตั้ง — จะใช้ของ Mooni แทน)',
      same: !!(D.publicKey && M.publicKey && D.publicKey === M.publicKey),
    }));
  }

  // ทดสอบ Upstash ตรง ๆ (เขียน+อ่าน) — ไว้ debug ว่าคีย์ถูกไหม (ไม่โชว์ token)
  if (process.env.RELAY_DEBUG === '1' && req.method === 'GET' && url.pathname === '/debug/store') {
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

  // ---- ร้านค้า (สาธารณะ) ----
  if (req.method === 'GET' && url.pathname === '/shop') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(SHOP_HTML);
  }

  // ล็อกอินหลังบ้านร้าน → เด้งไป Discord (ใช้ /auth/callback เดิม, state=shopadmin)
  if (req.method === 'GET' && url.pathname === '/shop/login') {
    if (!AUTH_ENABLED) { res.writeHead(503); return res.end('auth not configured'); }
    const auth = new URL('https://discord.com/api/oauth2/authorize');
    auth.searchParams.set('client_id', D.clientId);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('redirect_uri', REDIRECT_URI);
    auth.searchParams.set('scope', 'identify guilds.members.read');
    auth.searchParams.set('state', 'shopadmin:' + crypto.randomBytes(8).toString('hex'));
    auth.searchParams.set('prompt', 'consent');
    res.writeHead(302, { Location: auth.toString() });
    return res.end();
  }
  // แอปหน้าร้านถามว่าเราเป็นแอดมินไหม
  if (req.method === 'GET' && url.pathname === '/shop/api/me') {
    shopAdminFromReq(req).then((a) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(a ? { admin: true, name: a.name } : { admin: false }));
    }).catch(() => { try { res.writeHead(200, cors); res.end('{"admin":false}'); } catch {} });
    return;
  }
  // จัดการร้านจากหน้าร้าน (ต้องมียศแอดมิน)
  if (req.method === 'POST' && url.pathname.startsWith('/shop/api/admin/')) {
    const action = url.pathname.slice('/shop/api/admin/'.length);
    (async () => {
      const admin = await shopAdminFromReq(req);
      if (!admin) return { code: 403, body: { error: 'ไม่มีสิทธิ์ (ต้องมียศแอดมิน)' } };
      const data = await readJson(req);
      return doShopAdmin(action, data);
    })().then((out) => {
      res.writeHead(out.code, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(out.body));
    }).catch(() => { try { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'error' })); } catch {} });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/shop/api/config') {
    (async () => {
      const [s, products] = await Promise.all([getShopSettings(), getProducts()]);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({
        shopName: s.shopName || 'Mooni Shop', shopNote: s.shopNote || '',
        pay: { number: s.payNumber || '', name: s.payName || '', qr: s.payQr || '' },
        products: products.map((p) => ({ id: p.id, name: p.name, desc: p.desc, price: p.price, price30: p.price30, price90: p.price90, image: p.image, active: p.active })),
      }));
    })().catch(() => { try { res.writeHead(500, cors); res.end('{}'); } catch {} });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/shop/api/order') {
    readJson(req).then((data) => handleShopOrder(data, req)).then((out) => {
      res.writeHead(out.code, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(out.body));
    }).catch(() => { try { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'error' })); } catch {} });
    return;
  }

  // หน้าเว็บแอดมินจัดการสมาชิก
  if (req.method === 'GET' && url.pathname === '/panel') {
    const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    return res.end(gz ? PANEL_GZ : PANEL_HTML);
  }
  // หน้าแก้ข้อความในแอปแบบสด (hot-update) — เปิด /strings-admin ใส่รหัสแอดมิน แล้ว Save
  if (req.method === 'GET' && url.pathname === '/strings-admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mooni — แก้ข้อความในแอป</title>
<style>body{font-family:system-ui,'Segoe UI','Noto Sans Thai',sans-serif;background:#0a0a0c;color:#fdeef5;max-width:720px;margin:0 auto;padding:20px}h1{color:#ff7ab8;font-size:18px}input,textarea{width:100%;box-sizing:border-box;padding:10px;background:#17141b;color:#fdeef5;border:2px solid rgba(255,255,255,.14);border-radius:8px;font:inherit;margin:6px 0}textarea{min-height:320px;font-family:ui-monospace,Consolas,monospace;font-size:13px}button{padding:10px 16px;margin:4px 4px 4px 0;background:#d64f92;color:#fff;border:0;border-radius:8px;font:inherit;font-weight:700;cursor:pointer}.hint{color:#8ea6cc;font-size:13px}.status{margin-top:10px;min-height:20px}</style></head><body>
<h1>แก้ข้อความในแอป (hot-update)</h1>
<p class="hint">ใส่รหัสแอดมิน → Load → แก้ JSON (คีย์:ข้อความ) → Save &amp; push แล้วทุกแอปที่เปิดอยู่จะเปลี่ยนทันที</p>
<input id="key" type="password" placeholder="รหัสแอดมิน (ADMIN_KEY)" autocomplete="current-password">
<textarea id="json" placeholder='{"mc.homeTitle":"...","mc.play":"..."}'></textarea>
<div><button onclick="load()">Load</button><button onclick="save()">Save &amp; push</button></div>
<div class="status" id="s"></div>
<script>
const S=document.getElementById('s'),K=document.getElementById('key'),J=document.getElementById('json');
async function load(){try{const r=await fetch('/app-strings');J.value=JSON.stringify(await r.json(),null,2);S.textContent='โหลดแล้ว';}catch(e){S.textContent='โหลดไม่ได้';}}
async function save(){let obj;try{obj=JSON.parse(J.value||'{}');}catch(e){S.textContent='JSON ผิด: '+e.message;return;}try{const r=await fetch('/app-strings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:K.value,strings:obj})});const d=await r.json();S.textContent=r.ok?('ส่งแล้ว → '+d.sentTo+' เครื่อง'):('ผิดพลาด: '+(d.error||r.status));}catch(e){S.textContent='ส่งไม่ได้: '+e.message;}}
load();
</script></body></html>`);
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

      if (!ADMIN_KEY) {
        res.writeHead(503, headers);
        return res.end(JSON.stringify({ error: 'ADMIN_KEY is not configured' }));
      }
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

  // ---- ข้อความในแอป (hot-update strings): แอปดึงตอนเปิด, แอดมิน POST เพื่อแก้แล้ว push สด ----
  if (req.method === 'GET' && url.pathname === '/app-strings') {
    (async () => {
      const d = await upstash(['GET', 'mooni:appstrings']);
      let strings = {};
      try { if (d && d.result) strings = JSON.parse(d.result); } catch { /* ยังไม่เคยตั้ง */ }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(strings));
    })();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/app-strings') {
    readJson(req).then(async (data) => {
      const headers = { 'Content-Type': 'application/json', ...cors };
      if (!ADMIN_KEY) { res.writeHead(503, headers); return res.end(JSON.stringify({ error: 'ADMIN_KEY is not configured' })); }
      if (data.key !== ADMIN_KEY) { res.writeHead(401, headers); return res.end(JSON.stringify({ error: 'รหัสผ่านไม่ถูกต้อง' })); }
      const strings = (data.strings && typeof data.strings === 'object') ? data.strings : {};
      await upstash(['SET', 'mooni:appstrings', JSON.stringify(strings)]);
      const sentTo = broadcast({ type: 'strings', strings });   // push สดถึงทุกแอป
      console.log(`[relay] อัปเดตข้อความในแอป → ${sentTo} เครื่อง`);
      res.writeHead(200, headers); res.end(JSON.stringify({ ok: true, sentTo }));
    }).catch(() => { try { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'error' })); } catch {} });
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

/* ---------- ตรวจสุขภาพดิสคอร์ดเป็นระยะ — ดูผลได้ใน log ของ Render และใน /health ---------- */
let discordHealth = { ok: null, status: 0, checkedAt: 0 };

/** IP ขาออกของเซิร์ฟเวอร์ — ไว้ดูว่าเปลี่ยน IP แล้วหรือยัง เวลาโดนดิสคอร์ดบล็อก */
async function egressIp() {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    return String(d.ip || '').slice(0, 45);
  } catch { return ''; }
}

async function logDiscordHealth() {
  if (!D.botToken) {
    console.log('[discord] ยังไม่ได้ตั้ง DISCORD_BOT_TOKEN');
    discordHealth = { ok: false, status: 0, code: 'no-token', checkedAt: Date.now() };
    return;
  }
  const me = await dcFetch('/users/@me');
  if (!me.ok) {
    // ลองอีกครั้งด้วย UA แบบเบราว์เซอร์ — แยกให้ออกว่าเป็นที่ IP หรือเป็นที่ลายเซ็นของคำขอ
    const alt = await probeDiscord(DC_UA_BROWSER);
    console.log('[discord] บอทล็อกอินไม่ได้: ' + dcErrText(me) + ' → ' + dcHint(me.status, me.code))
    ;
    console.log('[discord] ลองด้วย UA เบราว์เซอร์ได้ผล: HTTP ' + alt.status + (alt.html ? ' (หน้า HTML)' : ''));
    discordHealth = {
      ok: false, status: me.status, code: me.code, reason: String(me.error || '').slice(0, 120),
      alt, checkedAt: Date.now(),
    };
    discordHealth.egressIp = await egressIp();
    return;
  }
  const m = await dcFetch('/guilds/' + D.guildId + '/members?limit=1');
  console.log('[discord] บอท ' + me.data.username + ' · เซิร์ฟเวอร์ ' + D.guildId + ' → '
    + (m.ok ? 'ดึงรายชื่อสมาชิกได้' : dcErrText(m) + ' → ' + dcHint(m.status, m.code)));
  discordHealth = {
    ok: m.ok, status: m.status, code: m.code || 0,
    reason: m.ok ? '' : String(m.error || '').slice(0, 120),
    membersOk: !!m.ok, checkedAt: Date.now(),
  };
  discordHealth.egressIp = await egressIp();
}
setTimeout(() => logDiscordHealth().catch(() => {}), 8000).unref?.();
setInterval(() => logDiscordHealth().catch(() => {}), 10 * 60 * 1000).unref?.();

server.listen(PORT, () => {
  console.log(`Mooni Relay รันที่พอร์ต ${PORT}`);
  console.log(`ระบบล็อกอิน Discord: ${AUTH_ENABLED ? 'เปิด (เช็คยศ Mooni)' : 'ปิด — ยังตั้ง DISCORD_* ไม่ครบ'}`);
  console.log(`บอทเช็คยศสด: ${D.botToken ? 'เปิด' : 'ปิด'} · คลังวันหมดอายุ (Upstash): ${STORE_ENABLED ? 'เปิด' : 'ปิด'}`);
  if (AUTH_ENABLED) console.log(`Redirect URI ที่ต้องใส่ใน Discord: ${REDIRECT_URI}`);
  console.log(`หน้าจัดการสมาชิก: ${PUBLIC_URL}/panel`);

  // บอท Uplimit Media รันในโปรเซสเดียวกัน (ปิดตัวเองเงียบ ๆ ถ้าไม่ได้ตั้ง UPLIMIT_TOKEN)
  uplimit.startUplimit().catch((err) => console.error('[uplimit] เริ่มไม่สำเร็จ:', err.message));

  // ยศเปลี่ยนในดิสหลัก/ดิสที่สอง → ล้างแคช + บอกแอปของคนนั้นให้เช็คใหม่ทันที (ไม่ต้องรอรอบ 30 วิ)
  startRoleWatch({
    token: D.botToken,
    guildIds: [D.guildId, D.guild2Id],
    onChange: (uid) => {
      cacheDropUid(uid);
      dcCache.delete('guild2:' + uid);
      broadcast({ type: 'auth:changed', uid: String(uid) });
    },
  });
});
