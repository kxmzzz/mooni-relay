// ทดสอบ worker พร็อกซี่ดิสคอร์ดด้วย Web API ชุดเดียวกับ workerd
// โหลดไฟล์จริงจาก relay/tools/discord-proxy-worker.js แล้วเรียก fetch ตรง ๆ
import fs from 'node:fs';

const SRC = 'C:/server/relay/tools/discord-proxy-worker.js';
const KEY = 'test-local-key';
const src = fs.readFileSync(SRC, 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const worker = mod.default;

const env = { PROXY_KEY: KEY };
let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

// ---------- 1) เส้นทางที่ไม่มีรหัส / รหัสผิด → 404 ----------
for (const url of [
  'https://w.example.com/',
  'https://w.example.com/v10/gateway',
  'https://w.example.com/wrong-key/v10/gateway',
  'https://w.example.com/test-local-key',
  'https://w.example.com/test-local-keyx/v10/gateway',
]) {
  const res = await worker.fetch(new Request(url), env);
  ok(`404 เมื่อเรียก ${new URL(url).pathname}`, res.status === 404, `status=${res.status}`);
}

// ---------- 2) ไม่ตั้ง PROXY_KEY เลย → ทุก path 404 ----------
const resNoKey = await worker.fetch(new Request('https://w.example.com//v10/gateway'), {});
ok('ไม่ตั้ง PROXY_KEY → 404', resNoKey.status === 404, `status=${resNoKey.status}`);

// ---------- 3) ตรวจเป้าหมายที่ต่อออกไป (ดัก fetch ไม่ให้ยิงจริง) ----------
const realFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (target, init) => {
  seen.push({ target, init, host: new Headers(init.headers).get('host'), cf: new Headers(init.headers).get('cf-connecting-ip') });
  return new Response('stub', { status: 200 });
};

await worker.fetch(
  new Request(`https://w.example.com/${KEY}/v10/guilds/123/roles`, {
    method: 'POST',
    headers: { authorization: 'Bot abc', 'content-type': 'application/json', host: 'w.example.com', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify({ name: 'Mooni' }),
  }),
  env
);
await worker.fetch(new Request(`https://w.example.com/${KEY}/v10/guilds/123/members?limit=5&after=0`), env);

ok('GET: เป้าหมายเป็น discord.com/api ตาม path เดิม', seen[1].target === 'https://discord.com/api/v10/guilds/123/members?limit=5&after=0', seen[1].target);
ok('POST: ออกที่ discord.com/api + method เดิม', seen[0].target === 'https://discord.com/api/v10/guilds/123/roles' && seen[0].init.method === 'POST', `${seen[0].target} ${seen[0].init.method}`);
ok('POST: ส่ง body ต่อ', seen[0].init.body != null);
ok('POST: เก็บ authorization ไว้ (ดิสคอร์ดต้องได้)', new Headers(seen[0].init.headers).get('authorization') === 'Bot abc');
ok('ตัด host ออก', seen[0].host === null);
ok('ตัด cf-connecting-ip ออก', seen[0].cf === null);
ok('GET: ไม่แนบ body', seen[1].init.body === undefined);

globalThis.fetch = realFetch;

// ---------- 4) ยิงจริงไปดิสคอร์ด ผ่านรหัสที่ถูก ----------
try {
  const live = await worker.fetch(new Request(`https://w.example.com/${KEY}/v10/gateway`), env);
  const text = await live.text();
  ok('ยิงจริง https://discord.com/api/v10/gateway', live.status === 200 && text.includes('"url"'), `status=${live.status} body=${text.slice(0, 80)}`);
} catch (err) {
  ok('ยิงจริง https://discord.com/api/v10/gateway', false, `เครือข่ายออกไม่ได้: ${err.message}`);
}

console.log(fail === 0 ? '\nสรุป: ผ่านทั้งหมด' : `\nสรุป: ล้มเหลว ${fail} ข้อ`);
// ไม่ใช้ process.exit() — บน Windows จะไปตัด handle ของ undici กลางทางแล้ว Node ล้มด้วย libuv assert
process.exitCode = fail === 0 ? 0 : 1;
