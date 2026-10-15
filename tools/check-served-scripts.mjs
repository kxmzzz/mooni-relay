// ตรวจว่า JS ที่ฝังอยู่ในหน้าที่ relay เสิร์ฟ "คอมไพล์ผ่าน" ทุกหน้า
//
// ทำไมต้องมี: สคริปต์ของหน้า /panel อยู่รวมกันเป็น <script> ก้อนเดียว
// ถ้าพลาดsyntax ที่ไหนแม้บรรทัดเดียว ปุ่มทั้งหน้าจะกดไม่ติดเงียบ ๆ
// (เคสจริง: เติมคอมเมนต์ // ต่อท้ายบรรทัด แล้ว `}` ปิด try ถูกกลืนเข้าไปในคอมเมนต์)
//
// ใช้: node relay/tools/check-served-scripts.mjs [base-url]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const PAGES = ['/', '/panel', '/shop', '/admin', '/jar'];
const tmp = path.join(os.tmpdir(), 'relay-served-script.js');

let failed = 0;
let checked = 0;

for (const page of PAGES) {
  let html;
  try {
    const res = await fetch(BASE + page);
    if (!res.ok) {
      console.log(`ข้าม  ${page} — HTTP ${res.status}`);
      continue;
    }
    html = await res.text();
  } catch (err) {
    console.log(`ข้าม  ${page} — ${err.message}`);
    continue;
  }

  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  blocks.forEach((code, i) => {
    checked++;
    fs.writeFileSync(tmp, code);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      console.log(`PASS  ${page} script#${i + 1} (${code.split('\n').length} บรรทัด)`);
    } catch (err) {
      failed++;
      const first = String(err.stderr || err.message).split('\n').slice(0, 3).join(' | ');
      console.log(`FAIL  ${page} script#${i + 1} → ${first}`);
    }
  });
}

console.log(failed === 0 ? `\nสรุป: ตรวจ ${checked} สคริปต์ ผ่านทั้งหมด` : `\nสรุป: สคริปต์พัง ${failed} จาก ${checked}`);
process.exitCode = failed === 0 ? 0 : 1;
