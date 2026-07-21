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
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'mooni';   // เปลี่ยนตอน deploy!

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

  if (req.method === 'GET' && (req.url === '/' || req.url === '/admin')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(ADMIN_HTML);
  }

  // เช็คสถานะ (โฮสต์บางที่ใช้ ping ให้ไม่หลับ)
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, clients: wss.clients.size }));
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

server.listen(PORT, () => console.log(`Mooni Relay รันที่พอร์ต ${PORT}`));
