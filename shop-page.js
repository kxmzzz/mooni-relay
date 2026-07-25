/**
 * หน้าเว็บร้านค้า (สาธารณะ) — /shop
 * ดึงสินค้า + ข้อมูลโอนเงินจาก /shop/api/config แล้วเรนเดอร์เอง
 */
module.exports = `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mooni Shop</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--pink:#ff7ab8;--pink-d:#d64f92;--bg:#0a0a0c;--card:#17141b;--line:#3a2030;--muted:#b58aa0;--text:#fdeef5}
  body{min-height:100vh;color:var(--text);font-family:system-ui,'Segoe UI','Leelawadee UI','Noto Sans Thai',sans-serif;
    background:radial-gradient(900px 500px at 50% -12%,rgba(255,122,184,.15),transparent 62%),var(--bg)}
  .wrap{max-width:1000px;margin:0 auto;padding:34px 18px 60px}
  header{text-align:center;margin-bottom:34px}
  header h1{font-size:32px;letter-spacing:.5px;background:linear-gradient(100deg,var(--pink-d),var(--pink));
    -webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:6px}
  header p{color:var(--muted);font-size:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
  .card{background:var(--card);border:2px solid var(--line);box-shadow:5px 5px 0 #000;display:flex;flex-direction:column;
    transition:transform .12s,box-shadow .12s}
  .card:hover{transform:translate(-3px,-3px);box-shadow:8px 8px 0 var(--pink-d)}
  .card .thumb{width:100%;aspect-ratio:1/1;object-fit:cover;background:#221820;display:block}
  .card .body{padding:14px;display:flex;flex-direction:column;gap:7px;flex:1}
  .card h3{font-size:15.5px;line-height:1.35}
  .card .desc{font-size:12.5px;color:var(--muted);line-height:1.55;flex:1;white-space:pre-wrap}
  .price{font-size:20px;font-weight:800;color:var(--pink)}
  .btn{padding:11px;font:inherit;font-size:14px;font-weight:800;cursor:pointer;border:2px solid #000;
    background:linear-gradient(100deg,var(--pink-d),var(--pink));color:#2a0f1c;box-shadow:3px 3px 0 #000;
    transition:transform .08s,box-shadow .08s}
  .btn:hover{transform:translate(-2px,-2px);box-shadow:5px 5px 0 #000}
  .btn:active{transform:translate(2px,2px);box-shadow:0 0 0 #000}
  .btn:disabled{opacity:.5;cursor:default;transform:none;box-shadow:3px 3px 0 #000}
  .btn.ghost{background:#241823;color:var(--text);box-shadow:none;border-color:var(--line)}

  /* ป๊อปอัพสั่งซื้อ */
  .mask{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;
    padding:18px;z-index:50;overflow-y:auto}
  .mask.on{display:flex}
  .modal{width:100%;max-width:430px;background:var(--card);border:2px solid var(--line);box-shadow:7px 7px 0 #000;padding:22px;margin:auto}
  .modal h2{font-size:18px;color:var(--pink);margin-bottom:3px}
  .modal .sum{font-size:13px;color:var(--muted);margin-bottom:16px}
  .pay{background:#0d0a10;border:2px dashed var(--line);padding:13px;margin-bottom:16px;font-size:13px;line-height:1.7}
  .pay b{color:var(--pink)}
  .pay img{max-width:180px;width:100%;margin:9px auto 0;display:block;border:2px solid var(--line)}
  label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin:12px 0 6px}
  input[type=text],input[type=file]{width:100%;padding:11px 12px;background:#0a0a0c;color:var(--text);
    border:2px solid var(--line);font:inherit;font-size:14px}
  input:focus{outline:none;border-color:var(--pink)}
  .hint{font-size:11.5px;color:var(--muted);margin-top:5px;line-height:1.5}
  .preview{max-width:100%;margin-top:9px;border:2px solid var(--line);display:none}
  .row{display:flex;gap:9px;margin-top:18px}
  .row .btn{flex:1}
  .status{margin-top:12px;font-size:13px;text-align:center;min-height:20px;line-height:1.55}
  .status.ok{color:#7ee0a6}.status.err{color:#ff5a6a}
  .empty{text-align:center;color:var(--muted);padding:50px 0;font-size:14px}
  .done{text-align:center;padding:12px 0}
  .done .big{font-size:42px;margin-bottom:8px}
  footer{text-align:center;color:var(--muted);font-size:11.5px;margin-top:36px;line-height:1.7}
</style></head><body>
<div class="wrap">
  <header>
    <h1 id="shopName">Mooni Shop</h1>
    <p id="shopNote">โอนเงินแล้วแนบสลิป ระบบจะส่งให้แอดมินตรวจ อนุมัติแล้วได้ยศทันที</p>
  </header>
  <div class="grid" id="grid"><div class="empty">กำลังโหลดสินค้า…</div></div>
  <footer>ตรวจสลิปโดยแอดมิน · ปกติไม่เกิน 24 ชม.<br>โอนแล้วอย่าลืมแนบสลิปและใส่ Discord ID ให้ถูกต้อง</footer>
</div>

<div class="mask" id="mask">
  <div class="modal">
    <div id="formView">
      <h2 id="mTitle">สั่งซื้อ</h2>
      <div class="sum" id="mSum"></div>
      <div class="pay" id="mPay"></div>
      <label for="fUid">Discord User ID ของคุณ *</label>
      <input id="fUid" type="text" inputmode="numeric" placeholder="เช่น 721186082020130862">
      <div class="hint">เปิด Discord → ตั้งค่า → ขั้นสูง → เปิด Developer Mode → คลิกขวาชื่อตัวเอง → Copy User ID</div>
      <label for="fSlip">สลิปโอนเงิน *</label>
      <input id="fSlip" type="file" accept="image/*">
      <img class="preview" id="prev" alt="">
      <label for="fNote">หมายเหตุ (ไม่บังคับ)</label>
      <input id="fNote" type="text" placeholder="เช่น ชื่อในเกม / ข้อความถึงแอดมิน">
      <div class="row">
        <button class="btn ghost" id="mCancel">ยกเลิก</button>
        <button class="btn" id="mSend">ส่งคำสั่งซื้อ</button>
      </div>
      <div class="status" id="mStatus"></div>
    </div>
    <div id="doneView" style="display:none">
      <div class="done">
        <div class="big">🎉</div>
        <h2>ส่งคำสั่งซื้อแล้ว!</h2>
        <div class="sum" style="margin-top:9px">แอดมินกำลังตรวจสลิป อนุมัติแล้วคุณจะได้รับยศใน Discord อัตโนมัติ</div>
      </div>
      <button class="btn" id="mClose" style="width:100%">ปิด</button>
    </div>
  </div>
</div>

<script>
const $=id=>document.getElementById(id);
let CFG={products:[],pay:{}},cur=null;

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const baht=n=>Number(n||0).toLocaleString('th-TH');

async function boot(){
  try{
    CFG=await fetch('/shop/api/config').then(r=>r.json());
    if(CFG.shopName)$('shopName').textContent=CFG.shopName;
    if(CFG.shopNote)$('shopNote').textContent=CFG.shopNote;
    render();
  }catch(e){$('grid').innerHTML='<div class="empty">โหลดสินค้าไม่ได้ ลองรีเฟรชหน้าใหม่</div>';}
}

function render(){
  const list=(CFG.products||[]).filter(p=>p.active!==false);
  if(!list.length){$('grid').innerHTML='<div class="empty">ยังไม่มีสินค้าในร้านตอนนี้</div>';return;}
  $('grid').innerHTML=list.map(p=>
    '<div class="card">'+
      (p.image?'<img class="thumb" src="'+esc(p.image)+'" alt="">':'<div class="thumb"></div>')+
      '<div class="body"><h3>'+esc(p.name)+'</h3>'+
      '<div class="desc">'+esc(p.desc||'')+'</div>'+
      '<div class="price">฿'+baht(p.price)+'</div>'+
      '<button class="btn" data-id="'+esc(p.id)+'">ซื้อเลย</button></div></div>').join('');
}

$('grid').addEventListener('click',e=>{
  const id=e.target.dataset?.id; if(!id)return;
  cur=(CFG.products||[]).find(p=>p.id===id); if(!cur)return;
  $('mTitle').textContent=cur.name;
  $('mSum').textContent='ราคา ฿'+baht(cur.price);
  const pay=CFG.pay||{};
  $('mPay').innerHTML='<div>โอนมาที่ <b>'+esc(pay.number||'(ยังไม่ตั้งค่า)')+'</b></div>'+
    (pay.name?'<div>ชื่อบัญชี <b>'+esc(pay.name)+'</b></div>':'')+
    '<div>ยอด <b>฿'+baht(cur.price)+'</b></div>'+
    (pay.qr?'<img src="'+esc(pay.qr)+'" alt="QR">':'');
  $('formView').style.display='';$('doneView').style.display='none';
  $('mStatus').textContent='';$('mStatus').className='status';
  $('prev').style.display='none';$('fSlip').value='';
  $('mask').classList.add('on');
});

$('fSlip').addEventListener('change',()=>{
  const f=$('fSlip').files[0];
  if(!f){$('prev').style.display='none';return;}
  const r=new FileReader();r.onload=()=>{$('prev').src=r.result;$('prev').style.display='block'};r.readAsDataURL(f);
});

const close=()=>$('mask').classList.remove('on');
$('mCancel').addEventListener('click',close);
$('mClose').addEventListener('click',close);
$('mask').addEventListener('click',e=>{if(e.target===$('mask'))close()});

$('mSend').addEventListener('click',async()=>{
  const uid=$('fUid').value.trim(),f=$('fSlip').files[0],st=$('mStatus');
  st.className='status';
  if(!/^\\d{15,25}$/.test(uid)){st.className='status err';st.textContent='ใส่ Discord User ID ให้ถูกต้อง (ตัวเลขยาว ๆ)';return;}
  if(!f){st.className='status err';st.textContent='กรุณาแนบสลิปโอนเงิน';return;}
  if(f.size>5*1024*1024){st.className='status err';st.textContent='รูปสลิปใหญ่เกิน 5MB';return;}

  $('mSend').disabled=true;st.textContent='กำลังส่ง…';
  try{
    const slipData=await new Promise((res,rej)=>{const fr=new FileReader();
      fr.onload=()=>res(String(fr.result).split(',')[1]);fr.onerror=()=>rej(new Error('อ่านไฟล์ไม่ได้'));fr.readAsDataURL(f)});
    const r=await fetch('/shop/api/order',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({productId:cur.id,discordId:uid,note:$('fNote').value.trim(),slipData,slipName:f.name})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'ส่งไม่สำเร็จ');
    $('formView').style.display='none';$('doneView').style.display='';
  }catch(e){st.className='status err';st.textContent=e.message;}
  finally{$('mSend').disabled=false;}
});

boot();
</script></body></html>`;
