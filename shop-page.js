/**
 * หน้าเว็บร้านค้า (สาธารณะ) — /shop  · ธีมมินิมอลพาสเทล
 * flow: กดซื้อ → ใส่ Discord ID + เลือก 30/90 วัน → ยืนยัน → QR พร้อมเพย์ + แปะสลิป → ส่ง
 */
module.exports = `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mooni Shop</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#fbf6f8; --bg2:#f3ecf5; --card:#ffffff; --ink:#5b5566; --ink-soft:#9a93a6;
    --line:#efe6ee; --pink:#f2a8c4; --pink-d:#e77fa8; --lav:#cdb9ec; --mint:#b7e6cf;
    --shadow:0 10px 30px rgba(150,120,160,.12);
  }
  body{min-height:100vh;color:var(--ink);font-family:'Segoe UI','Leelawadee UI','Noto Sans Thai',system-ui,sans-serif;
    background:linear-gradient(170deg,#fdf3f7 0%,#f4f0fb 55%,#eef8f4 100%);background-attachment:fixed}
  .wrap{max-width:980px;margin:0 auto;padding:46px 18px 70px}
  header{text-align:center;margin-bottom:38px}
  header h1{font-size:30px;font-weight:800;letter-spacing:.3px;color:#6b5e78}
  header p{color:var(--ink-soft);font-size:14px;margin-top:8px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:20px}
  .card{background:var(--card);border-radius:22px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;
    transition:transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .35s}
  .card:hover{transform:translateY(-6px);box-shadow:0 18px 40px rgba(150,120,160,.2)}
  .thumb{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:linear-gradient(135deg,#fce4ee,#e9e0f7)}
  .thumb.ph{display:flex;align-items:center;justify-content:center;font-size:44px;opacity:.6}
  .card .body{padding:16px 17px 18px;display:flex;flex-direction:column;gap:8px;flex:1}
  .card h3{font-size:16px;font-weight:700;color:#6b5e78}
  .card .desc{font-size:12.5px;color:var(--ink-soft);line-height:1.6;flex:1;white-space:pre-wrap}
  .from{font-size:13px;color:var(--ink-soft)}
  .from b{font-size:19px;color:var(--pink-d);font-weight:800}
  .btn{padding:12px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;border:none;border-radius:14px;
    background:linear-gradient(120deg,var(--pink),var(--lav));color:#fff;box-shadow:0 6px 16px rgba(231,127,168,.32);
    transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s,filter .25s}
  .btn:hover{transform:translateY(-2px);box-shadow:0 10px 22px rgba(231,127,168,.4)}
  .btn:active{transform:translateY(0)}
  .btn:disabled{opacity:.55;cursor:default;transform:none}
  .btn.soft{background:#f1ecf5;color:#7d7488;box-shadow:none}
  .btn.soft:hover{background:#e9e2f0}

  /* ป๊อปอัพนุ่ม ๆ */
  .mask{position:fixed;inset:0;background:rgba(80,60,90,.28);backdrop-filter:blur(3px);
    display:flex;align-items:center;justify-content:center;padding:18px;z-index:60;overflow-y:auto;
    opacity:0;pointer-events:none;transition:opacity .3s ease}
  .mask.on{opacity:1;pointer-events:auto}
  .modal{width:100%;max-width:420px;background:var(--card);border-radius:24px;box-shadow:0 24px 60px rgba(120,90,140,.28);
    padding:26px 24px;margin:auto;transform:translateY(16px) scale(.97);opacity:0;transition:transform .32s cubic-bezier(.2,.9,.2,1),opacity .32s}
  .mask.on .modal{transform:translateY(0) scale(1);opacity:1}
  .modal h2{font-size:19px;font-weight:800;color:#6b5e78}
  .modal .sub{font-size:13px;color:var(--ink-soft);margin-top:3px;margin-bottom:18px}
  .step{display:none}.step.on{display:block;animation:fade .35s ease}
  @keyframes fade{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
  label{display:block;font-size:12.5px;font-weight:600;color:#8a8296;margin:14px 0 7px}
  input[type=text],input[type=file]{width:100%;padding:12px 13px;background:#faf7fb;color:var(--ink);
    border:1.5px solid var(--line);border-radius:12px;font:inherit;font-size:14px;transition:border-color .2s}
  input:focus{outline:none;border-color:var(--pink)}
  .hint{font-size:11.5px;color:var(--ink-soft);margin-top:6px;line-height:1.55}
  .pills{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap}
  .pill{flex:1;min-width:110px;border:1.5px solid var(--line);border-radius:15px;padding:13px;cursor:pointer;text-align:center;
    background:#faf7fb;transition:border-color .25s,background .25s,transform .2s}
  .pill:hover{transform:translateY(-2px)}
  .pill.on{border-color:var(--pink);background:linear-gradient(120deg,#fde7f0,#efe6fb)}
  .pill .d{font-size:14px;font-weight:700;color:#6b5e78}
  .pill .p{font-size:16px;font-weight:800;color:var(--pink-d);margin-top:3px}
  .pay{background:#faf5f8;border-radius:16px;padding:16px;text-align:center;margin-bottom:6px}
  .pay .total{font-size:15px;color:var(--ink-soft)}
  .pay .total b{font-size:24px;color:var(--pink-d);display:block;margin-top:2px}
  .pay img{max-width:200px;width:100%;margin:12px auto 8px;display:block;border-radius:12px;border:1.5px solid var(--line)}
  .pay .num{font-size:14px}.pay .num b{color:var(--pink-d)}
  .preview{max-width:100%;margin-top:9px;border-radius:12px;border:1.5px solid var(--line);display:none}
  .row{display:flex;gap:10px;margin-top:20px}.row .btn{flex:1}
  .status{margin-top:12px;font-size:13px;text-align:center;min-height:20px;line-height:1.55}
  .status.err{color:#e0607f}
  .empty{grid-column:1/-1;text-align:center;color:var(--ink-soft);padding:56px 0;font-size:14px}
  .done{text-align:center;padding:6px 0 2px}.done .big{font-size:46px;margin-bottom:8px}
  footer{text-align:center;color:var(--ink-soft);font-size:11.5px;margin-top:40px;line-height:1.8}
</style></head><body>
<div class="wrap">
  <header><h1 id="shopName">Mooni Shop</h1><p id="shopNote">โอนเงินแล้วแนบสลิป ระบบส่งให้แอดมินตรวจ อนุมัติแล้วได้ยศทันที</p></header>
  <div class="grid" id="grid"><div class="empty">กำลังโหลดสินค้า…</div></div>
  <footer>ตรวจสลิปโดยแอดมิน · ปกติไม่เกิน 24 ชม.</footer>
</div>

<div class="mask" id="mask">
  <div class="modal">
    <!-- ขั้น 1: ใส่ Discord ID + เลือกระยะเวลา -->
    <div class="step on" id="s1">
      <h2 id="mTitle">สั่งซื้อ</h2>
      <div class="sub" id="mDesc"></div>
      <label>Discord User ID ของคุณ</label>
      <input id="fUid" type="text" inputmode="numeric" placeholder="เช่น 721186082020130862">
      <div class="hint">Discord → ตั้งค่า → ขั้นสูง → เปิด Developer Mode → คลิกขวาชื่อตัวเอง → Copy User ID</div>
      <label>เลือกระยะเวลา</label>
      <div class="pills" id="mPills"></div>
      <div class="row"><button class="btn soft" id="c1">ยกเลิก</button><button class="btn" id="next1">ยืนยัน</button></div>
      <div class="status" id="st1"></div>
    </div>
    <!-- ขั้น 2: จ่ายเงิน + แปะสลิป -->
    <div class="step" id="s2">
      <h2>ชำระเงิน</h2>
      <div class="sub" id="mSum2"></div>
      <div class="pay" id="mPay"></div>
      <label>แนบสลิปโอนเงิน</label>
      <input id="fSlip" type="file" accept="image/*">
      <img class="preview" id="prev" alt="">
      <div class="row"><button class="btn soft" id="back2">ย้อนกลับ</button><button class="btn" id="send2">ส่งคำสั่งซื้อ</button></div>
      <div class="status" id="st2"></div>
    </div>
    <!-- ขั้น 3: สำเร็จ -->
    <div class="step" id="s3">
      <div class="done"><div class="big">🎉</div><h2>ส่งคำสั่งซื้อแล้ว!</h2>
        <div class="sub" style="margin-top:9px">แอดมินกำลังตรวจสลิป อนุมัติแล้วคุณจะได้รับยศใน Discord อัตโนมัติ</div></div>
      <button class="btn" id="c3" style="width:100%;margin-top:8px">เสร็จสิ้น</button>
    </div>
  </div>
</div>

<script>
const $=id=>document.getElementById(id);
let CFG={products:[],pay:{}},cur=null,pick=null;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const baht=n=>Number(n||0).toLocaleString('th-TH');

/** คืนตัวเลือกระยะเวลาของสินค้า (กรองเฉพาะที่ตั้งราคา) */
function optsOf(p){
  const o=[];
  if(p.price30>0)o.push({days:30,label:'30 วัน',price:p.price30});
  if(p.price90>0)o.push({days:90,label:'90 วัน',price:p.price90});
  if(!o.length&&p.price>0)o.push({days:0,label:'ซื้อ',price:p.price});
  return o;
}
const minPrice=p=>Math.min(...optsOf(p).map(o=>o.price));

async function boot(){
  try{
    CFG=await fetch('/shop/api/config').then(r=>r.json());
    if(CFG.shopName)$('shopName').textContent=CFG.shopName;
    if(CFG.shopNote)$('shopNote').textContent=CFG.shopNote;
    render();
  }catch(e){$('grid').innerHTML='<div class="empty">โหลดสินค้าไม่ได้ ลองรีเฟรชใหม่</div>';}
}
function render(){
  const list=(CFG.products||[]).filter(p=>p.active!==false&&optsOf(p).length);
  if(!list.length){$('grid').innerHTML='<div class="empty">ยังไม่มีสินค้าในร้านตอนนี้</div>';return;}
  $('grid').innerHTML=list.map(p=>
    '<div class="card">'+
    (p.image?'<img class="thumb" src="'+esc(p.image)+'">':'<div class="thumb ph">🎁</div>')+
    '<div class="body"><h3>'+esc(p.name)+'</h3><div class="desc">'+esc(p.desc||'')+'</div>'+
    '<div class="from">เริ่มต้น <b>฿'+baht(minPrice(p))+'</b></div>'+
    '<button class="btn" data-id="'+esc(p.id)+'">ซื้อเลย</button></div></div>').join('');
}

function openModal(p){
  cur=p;pick=null;
  $('mTitle').textContent=p.name;$('mDesc').textContent=p.desc||'';
  $('fUid').value='';$('fSlip').value='';$('prev').style.display='none';
  $('st1').textContent='';$('st2').textContent='';
  const opts=optsOf(p);
  $('mPills').innerHTML=opts.map((o,i)=>'<div class="pill" data-i="'+i+'"><div class="d">'+o.label+'</div><div class="p">฿'+baht(o.price)+'</div></div>').join('');
  if(opts.length===1){$('mPills').firstChild.classList.add('on');pick=opts[0];}
  showStep('s1');$('mask').classList.add('on');
}
function showStep(id){['s1','s2','s3'].forEach(s=>$(s).classList.toggle('on',s===id));}
const close=()=>$('mask').classList.remove('on');

$('grid').addEventListener('click',e=>{const id=e.target.dataset?.id;if(!id)return;
  const p=(CFG.products||[]).find(x=>x.id===id);if(p)openModal(p);});
$('mPills').addEventListener('click',e=>{const el=e.target.closest('.pill');if(!el)return;
  [...$('mPills').children].forEach(c=>c.classList.remove('on'));el.classList.add('on');
  pick=optsOf(cur)[+el.dataset.i];});
$('c1').addEventListener('click',close);$('c3').addEventListener('click',close);
$('mask').addEventListener('click',e=>{if(e.target===$('mask'))close();});
$('back2').addEventListener('click',()=>showStep('s1'));

$('next1').addEventListener('click',()=>{
  const uid=$('fUid').value.trim(),st=$('st1');st.className='status';
  if(!/^\\d{15,25}$/.test(uid)){st.className='status err';st.textContent='ใส่ Discord User ID ให้ถูกต้อง (ตัวเลขยาว ๆ)';return;}
  if(!pick){st.className='status err';st.textContent='เลือกระยะเวลาก่อน';return;}
  const pay=CFG.pay||{};
  $('mSum2').textContent=cur.name+(pick.days?' · '+pick.label:'');
  $('mPay').innerHTML='<div class="total">ยอดที่ต้องโอน<b>฿'+baht(pick.price)+'</b></div>'+
    (pay.qr?'<img src="'+esc(pay.qr)+'">':'')+
    (pay.number?'<div class="num">พร้อมเพย์ <b>'+esc(pay.number)+'</b></div>':'')+
    (pay.name?'<div class="num" style="color:#9a93a6;margin-top:2px">'+esc(pay.name)+'</div>':'');
  showStep('s2');
});
$('fSlip').addEventListener('change',()=>{const f=$('fSlip').files[0];if(!f){$('prev').style.display='none';return;}
  const r=new FileReader();r.onload=()=>{$('prev').src=r.result;$('prev').style.display='block'};r.readAsDataURL(f);});

$('send2').addEventListener('click',async()=>{
  const f=$('fSlip').files[0],st=$('st2');st.className='status';
  if(!f){st.className='status err';st.textContent='กรุณาแนบสลิปโอนเงิน';return;}
  if(f.size>5*1024*1024){st.className='status err';st.textContent='รูปสลิปใหญ่เกิน 5MB';return;}
  $('send2').disabled=true;st.textContent='กำลังส่ง…';
  try{
    const slipData=await new Promise((res,rej)=>{const fr=new FileReader();
      fr.onload=()=>res(String(fr.result).split(',')[1]);fr.onerror=()=>rej(new Error('อ่านไฟล์ไม่ได้'));fr.readAsDataURL(f)});
    const r=await fetch('/shop/api/order',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({productId:cur.id,discordId:$('fUid').value.trim(),days:pick.days,slipData,slipName:f.name})});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'ส่งไม่สำเร็จ');
    showStep('s3');
  }catch(e){st.className='status err';st.textContent=e.message;}
  finally{$('send2').disabled=false;}
});
boot();
</script></body></html>`;
