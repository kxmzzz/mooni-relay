/**
 * ตรวจว่าโทเคนบอทดิสคอร์ดใช้ได้ไหม + บอทเห็นเซิร์ฟเวอร์/ดึงรายชื่อ/ให้ยศได้ไหม
 *
 * ใช้รันจาก "เครื่องตัวเอง" (คนละ IP กับ Render) เพื่อแยกให้ออกว่า
 *   - โทเคนผิดหรือสิทธิ์ไม่พอ   หรือ
 *   - IP ของโฮสต์ถูกดิสคอร์ดบล็อก
 *
 * วิธีใช้ (โทเคนอยู่ในเครื่องคุณเท่านั้น ส่งไปแค่ discord.com):
 *   Windows cmd:      set DISCORD_BOT_TOKEN=โทเคน && node tools/check-bot.js
 *   PowerShell:       $env:DISCORD_BOT_TOKEN="โทเคน"; node tools/check-bot.js
 *   Git Bash / macOS: DISCORD_BOT_TOKEN=โทเคน node tools/check-bot.js
 *
 * ใส่ DISCORD_GUILD_ID / DISCORD_ROLE_ID ด้วยก็ได้ เพื่อเช็คเซิร์ฟเวอร์ สมาชิก และสิทธิ์ให้ยศ
 */

const TOKEN = String(process.env.DISCORD_BOT_TOKEN || '').trim().replace(/^bot\s+/i, '');
const GUILD = String(process.env.DISCORD_GUILD_ID || '').replace(/\D/g, '');
const ROLE = String(process.env.DISCORD_ROLE_ID || '').replace(/\D/g, '');

if (!TOKEN) {
  console.error('ยังไม่ได้ใส่ DISCORD_BOT_TOKEN');
  console.error('ตัวอย่าง: DISCORD_BOT_TOKEN=โทเคน node tools/check-bot.js');
  process.exit(1);
}

const API = 'https://discord.com/api/v10';
const call = (path) => fetch(API + path, {
  headers: { Authorization: `Bot ${TOKEN}`, 'User-Agent': 'MooniBotCheck/1.0' },
});

/** อธิบายรหัส error ให้อ่านรู้เรื่อง */
function explain(status, data) {
  const code = data?.code;
  if (status === 401) return 'โทเคนไม่ถูกต้อง/ถูกยกเลิก → Developer Portal → Bot → Reset Token แล้วคัดลอกใหม่';
  if (status === 403 && code === 50001) return 'บอทไม่เห็นข้อมูลนี้ → ยังไม่ได้เชิญบอทเข้าเซิร์ฟเวอร์ หรือยังไม่เปิด Server Members Intent';
  if (status === 403 && code === 50013) return 'บอทขาดสิทธิ์ → ให้ Manage Roles/Manage Channels และลากยศบอทให้สูงกว่ายศที่จัดการ';
  if (status === 404 && code === 10004) return 'ไม่รู้จักเซิร์ฟเวอร์นี้ → DISCORD_GUILD_ID ไม่ถูกต้อง หรือบอทไม่ได้อยู่เซิร์ฟเวอร์นั้น';
  if (status === 429) return 'ถูกจำกัดคำขอ → รอสักครู่แล้วลองใหม่';
  return '';
}

/** ยิงคำขอหนึ่งครั้งแล้วรายงานผล — คืนข้อมูลถ้าสำเร็จ, null ถ้าไม่ */
async function show(label, path) {
  let r;
  try {
    r = await call(path);
  } catch (e) {
    console.log(`❌ ${label}: ต่อ discord.com ไม่ได้ (${e.message}) → อินเทอร์เน็ตมีปัญหา หรือถูกบล็อกในระดับเครือข่าย`);
    return null;
  }
  const txt = r.status === 204 ? '' : await r.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { /* อาจเป็นหน้า HTML */ }
  if (r.ok) {
    console.log(`✅ ${label}`);
    return data;
  }
  const isHtml = /^\s*<(?:!doctype|html)/i.test(txt);
  const msg = data?.message || (isHtml ? 'ได้หน้า HTML กลับมา (Cloudflare/ดิสคอร์ดบล็อก IP นี้)' : txt.slice(0, 120));
  console.log(`❌ ${label}: HTTP ${r.status} — ${msg}`);
  const fix = explain(r.status, data);
  if (fix) console.log(`   ↳ ${fix}`);
  return null;
}

(async () => {
  console.log('ตรวจบอทกับดิสคอร์ด…\n');

  const me = await show('บอทล็อกอินได้ (GET /users/@me)', '/users/@me');
  if (me) console.log(`   ↳ บัญชี: ${me.username} (id ${me.id})`);

  if (!GUILD) {
    console.log('\n(ไม่ได้ใส่ DISCORD_GUILD_ID — ข้ามการเช็คเซิร์ฟเวอร์/สมาชิก/ยศ)');
    console.log('สรุป: ถ้าบรรทัดบนเป็น ✅ = โทเคนใช้ได้ ปัญหาอยู่ที่ IP ของโฮสต์');
    return;
  }

  const g = await show('เห็นเซิร์ฟเวอร์หลัก (GET /guilds/{id})', `/guilds/${GUILD}`);
  if (g) console.log(`   ↳ เซิร์ฟเวอร์: ${g.name}`);

  const m = await show('ดึงรายชื่อสมาชิกได้ (ต้องเปิด Server Members Intent)', `/guilds/${GUILD}/members?limit=1`);
  if (m) console.log(`   ↳ ทดสอบได้ ${Array.isArray(m) ? m.length : 0} รายการ`);

  const roles = await show('อ่านรายการยศได้ (ใช้เช็คลำดับยศ)', `/guilds/${GUILD}/roles`);
  if (Array.isArray(roles) && me) {
    const myMember = await show('อ่านข้อมูลบอทในเซิร์ฟเวอร์ได้', `/guilds/${GUILD}/members/${me.id}`);
    const myRoles = Array.isArray(myMember?.roles) ? myMember.roles : [];
    const myTop = roles.filter((r) => myRoles.includes(r.id)).reduce((a, r) => Math.max(a, r.position || 0), 0);
    console.log(`\n   ↳ ยศสูงสุดของบอทอยู่ตำแหน่ง ${myTop} (ยิ่งมากยิ่งสูง)`);
    if (ROLE) {
      const target = roles.find((r) => r.id === ROLE);
      if (!target) {
        console.log(`   ❌ ไม่พบยศ id ${ROLE} ในเซิร์ฟเวอร์นี้`);
      } else {
        const can = (target.position || 0) < myTop;
        console.log(`   ${can ? '✅' : '❌'} ยศ "${target.name}" ตำแหน่ง ${target.position} ${can ? '→ บอทให้ยศนี้ได้' : '→ บอทให้ไม่ได้ (ยศบอทอยู่ต่ำกว่า) ลากยศบอทขึ้นให้สูงกว่า'}`);
      }
      if (!/^\\d+$/.test(ROLE)) console.log('   ℹ️ DISCORD_ROLE_ID ควรเป็นตัวเลขล้วน');
    }
  }

  console.log('\nสรุป: ถ้าทุกบรรทัดเป็น ✅ = โทเคนและสิทธิ์ปกติดี ปัญหาอยู่ที่ IP ของโฮสต์ที่ถูกดิสคอร์ดบล็อก');
})();
