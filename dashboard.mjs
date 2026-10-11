#!/usr/bin/env node
// ============================================================================
// Shopee 幸運蝦轉盤 監視網頁 (圖表)
// ----------------------------------------------------------------------------
// 讀取 monitor.mjs 寫的 feed-data.jsonl（每輪統計 + Bark/alert 事件），
// 提供 :8787 網頁，用 Chart.js 畫：中獎量 / 非1幣佔比 / 組成 / feed lag。
// 啟動時會把 monitor.log 中「今天」的 feed 行 backfill 進資料檔（有歷史就看）。
// ----------------------------------------------------------------------------
// 用法：
//   node dashboard.mjs --port 8787 --host 127.0.0.1
// ============================================================================

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, appendFileSync, writeFileSync } from "node:fs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return def;
}
const PORT = +arg("port", 8787);
const HOST = arg("host", "127.0.0.1");
const DATA = "feed-data.jsonl";
const LOG = "monitor.log";

let cache = { mtime: 0, rows: [] };
function loadRows() {
  try {
    if (!existsSync(DATA)) return cache.rows;
    const st = statSync(DATA);
    if (st.mtimeMs !== cache.mtime) {
      const rows = readFileSync(DATA, "utf8")
        .split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      cache = { mtime: st.mtimeMs, rows };
    }
  } catch {}
  return cache.rows;
}

// ----------------------------------------------------------------------------
// backfill：把 monitor.log 今天的 feed 行轉成 JSONL（只做一次：資料檔尚未建立時）
function backfill() {
  if (existsSync(DATA) && statSync(DATA).size > 0) return;
  if (!existsSync(LOG)) return;
  const re =
    /^\[(\d{2}):(\d{2}):(\d{2})\] feed lag=(\d+)s(.*?)\| 近(\d+)s: (\d+)中獎, 非1幣=(\d+)\(([\d.]+)%\) \[1幣(\d+)\/30券(\d+)\/50券(\d+)\/100券(\d+)\/10幣(\d+)\] \| 距結束≈(\d+)分/;
  const d = new Date();
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  const rows = [];
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    const t = base + (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    if (t > Date.now() / 1000 + 600 || t < (Date.now() / 1000) - 26 * 3600) continue;
    rows.push({
      t, mode: "active",
      lag: +m[4], stale: m[5].includes("STALE") ? 1 : 0,
      win: +m[6], total: +m[7], non: +m[8], frac: +m[9],
      n1: +m[10], n30: +m[11], n50: +m[12], n100: +m[13], n10: +m[14],
      leftMin: +m[15], alert: 0,
    });
  }
  if (rows.length) {
    writeFileSync(DATA, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`backfill: ${rows.length} 筆歷史資料（今天）`);
  }
}

// ----------------------------------------------------------------------------
const HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🦐 幸運蝦轉盤 監視</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#0f1419;--panel:#1a2129;--line:#2c3a47;--tx:#e6edf3;--sub:#8b98a5;--red:#ff5d5d;--blu:#4da3ff;--grn:#3ddc97}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--tx);font-family:-apple-system,"PingFang TC",sans-serif;padding:16px}
h1{font-size:18px;margin:0 0 4px} .sub{color:var(--sub);font-size:12px;margin-bottom:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.card .k{font-size:11px;color:var(--sub)} .card .v{font-size:20px;font-weight:700;margin-top:2px}
.ranges{margin-bottom:12px} .ranges button{background:var(--panel);border:1px solid var(--line);color:var(--tx);
border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;margin-right:6px}
.ranges button.on{background:var(--blu);color:#06121f;border-color:var(--blu)}
.chart{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:14px;position:relative;height:270px}
.chart h2{font-size:13px;margin:0 0 6px;color:var(--sub);font-weight:600}
canvas{position:absolute;inset:0;width:100%!important;height:100%!important}
.alerts{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:12px}
.alerts li{list-style:none;margin:4px 0;padding:6px 8px;border-radius:6px;background:#15202b}
.alerts .tm{color:var(--sub);margin-right:8px} .alert-ico{color:var(--red)}
#status{color:var(--sub);font-size:12px;margin-bottom:10px}
</style>
</head>
<body>
<h1>🦐 幸運蝦轉盤 — 即時監視</h1>
<div class="sub" id="status">載入中…</div>
<div class="cards">
  <div class="card"><div class="k">模式</div><div class="v" id="c-mode">-</div></div>
  <div class="card"><div class="k">近180s 中獎</div><div class="v" id="c-total">-</div></div>
  <div class="card"><div class="k">非1幣</div><div class="v" id="c-non">-</div></div>
  <div class="card"><div class="k">非1幣佔比</div><div class="v" id="c-frac">-</div></div>
  <div class="card"><div class="k">feed lag</div><div class="v" id="c-lag">-</div></div>
  <div class="card"><div class="k">距結束</div><div class="v" id="c-left">-</div></div>
</div>
<div class="ranges">
  <button data-m="15">15分</button><button data-m="60" class="on">1小時</button>
  <button data-m="360">6小時</button><button data-m="1440">24小時</button><button data-m="100000">全部</button>
</div>
<div class="chart"><h2>中獎量（近180s 窗口）vs 爆量門檻(12)</h2><canvas id="ch-total"></canvas></div>
<div class="chart"><h2>非1幣佔比 %（觸發線 10%）</h2><canvas id="ch-frac"></canvas></div>
<div class="chart"><h2>非1幣組成（30券/50券/100券/10幣）</h2><canvas id="ch-compo"></canvas></div>
<div class="chart"><h2>feed 落後秒數（stale=紅點）</h2><canvas id="ch-lag"></canvas></div>
<div class="alerts"><b>最近推播 / 事件</b><ul id="alerts"></ul></div>
<script>
const $=(id)=>document.getElementById(id);
let minutes=60, charts={};
function tfmt(t){const d=new Date(t*1000);return d.toLocaleTimeString("zh-TW",{hour12:false})}
function mk(id,cfg){charts[id]=new Chart($(id),cfg);}
function refresh(cfg){
  const d=cfg.data;
  const series=d.series.filter(r=>r.t>=d.now-minutes*60);
  const xs=series.map(r=>tfmt(r.t));
  const mild=cfg.type==="compo";
  const all=cfg.type==="all";
  const ch=charts[cfg.el];
  if(!ch)return;
  if(all){
    ch.data.labels=xs;
    ch.data.datasets[0].data=series.map(r=>r.total);
    ch.data.datasets[1].data=series.map(r=>r.non);
    ch.data.datasets[2].data=series.map(()=>12); // 爆量門檻
  } else if(mild){
    ch.data.labels=xs;
    const sets=ch.data.datasets;
    sets.forEach((s,i)=>{const k=["n30","n50","n100","n10"][i];s.data=series.map(r=>r[k]||0)});
  } else if(cfg.type==="frac"){
    ch.data.labels=xs; ch.data.datasets[0].data=series.map(r=>r.frac);
    ch.data.datasets[1].data=series.map(()=>10); // 觸發線
  } else if(cfg.type==="lag"){
    ch.data.labels=xs; ch.data.datasets[0].data=series.map(r=>r.lag);
    const stale=series.filter(r=>r.stale).map(r=>({x:tfmt(r.t),y:r.lag}));
    ch.data.datasets[1].data=stale;
  }
  ch.update("none");
}
function build(){
  if(Object.keys(charts).length)return;
  const base=(label,color,fill=false)=>({label,borderColor:color,backgroundColor:color+(fill?"22":"00"),borderWidth:1.5,pointRadius:0,tension:.25,fill});
  const opt={responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{ticks:{maxTicksLimit:8,color:"#8b98a5",maxRotation:0},grid:{color:"#22303d"}},y:{ticks:{color:"#8b98a5"},grid:{color:"#22303d"}}},plugins:{legend:{labels:{color:"#e6edf3",boxWidth:12,font:{size:11}}}}};
  mk("ch-total",{type:"line",data:{labels:[],datasets:[
    base("總中獎", "#4da3ff"),base("非1幣", "#ff5d5d"),
    {type:"line",label:"門檻12",data:[],borderColor:"#ffb020",borderDash:[4,4],pointRadius:0,borderWidth:1}
  ]},options:opt});
  mk("ch-frac",{type:"line",data:{labels:[],datasets:[
    base("非1幣佔比%", "#ff9d5c"),
    {type:"line",label:"觸發10%",data:[],borderColor:"#ff5d5d",borderDash:[4,4],pointRadius:0,borderWidth:1}
  ]},options:opt});
  mk("ch-compo",{type:"line",data:{labels:[],datasets:[
    base("30券","#3ddc97"),base("50券","#4da3ff"),base("100券","#c792ea"),base("10幣","#ffd54f")
  ]},options:opt});
  mk("ch-lag",{type:"line",data:{labels:[],datasets:[
    base("lag(s)","#8b98a5"),
    {type:"scatter",label:"stale",data:[],borderColor:"#ff5d5d",backgroundColor:"#ff5d5d",pointRadius:3}
  ]},options:opt});
}
function parse(extra){
  const el=document.getElementById(extra.el); if(!el)return null;
  return el;
}
async function load(){
  build();
  try{
    const r=await fetch("/api/feed?minutes="+minutes);
    const d=await r.json();
    $("status").textContent="更新 "+(new Date(d.now*1000).toLocaleString("zh-TW",{hour12:false}))+" ｜ 資料點 "+d.series.length+" ｜ "+(d.latest?(d.latest.mode==="idle"?"待機(等隔天場次)":(d.latest.leftMin!=null?"活動剩餘 "+d.latest.leftMin+" 分":"🟢 監視中 (feed 模式)")):"無資料");
    const l=d.latest||{};
    $("c-mode").textContent=l.mode==="idle"?"😴待機":(l.mode==="active"?"🟢監視中":"?");
    $("c-total").textContent=(l.total??"-")
    $("c-non").textContent=(l.non??"-")
    $("c-frac").textContent=(l.frac??"-")+"%"
    $("c-lag").textContent=(l.lag??"-")+"s"
    $("c-left").textContent=(l.mode==="idle"?"—":(l.leftMin!=null?l.leftMin+"分":"feed"))
    refresh({el:"ch-total",data:d,type:"all"});
    refresh({el:"ch-frac",data:d,type:"frac"});
    refresh({el:"ch-compo",data:d,type:"compo"});
    refresh({el:"ch-lag",data:d,type:"lag"});
    const ul=$("alerts"); ul.innerHTML="";
    (d.alerts||[]).slice(-12).reverse().forEach(a=>{
      const li=document.createElement("li");
      li.innerHTML='<span class="tm">'+tfmt(a.t)+'</span><span class="alert-ico">🔔</span>'+a.title.replace(/</g,"&lt;");
      ul.appendChild(li);
    });
    if(!d.alerts.length){const li=document.createElement("li");li.textContent="（尚未有推播事件）";ul.appendChild(li);}
  }catch(e){$("status").textContent="❌ 連線失敗 "+e.message;}
}
document.querySelectorAll(".ranges button").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".ranges button").forEach(x=>x.classList.remove("on"));
  b.classList.add("on"); minutes=+b.dataset.m; load();
});
load();
setInterval(load,15000);
</script>
</body></html>`;

// ----------------------------------------------------------------------------
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }
  if (u.pathname === "/api/feed") {
    const rows = loadRows();
    let series = rows.filter((r) => r.type !== "alert");
    const alerts = rows.filter((r) => r.type === "alert").slice(-30);
    series = series.slice(-6000);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ now: Date.now() / 1000, series, alerts, latest: series[series.length - 1] || null }));
    return;
  }
  if (u.pathname === "/health") { res.writeHead(200).end("ok"); return; }
  res.writeHead(404).end("not found");
});

backfill();
server.listen(PORT, HOST, () => console.log(`📊 監視網頁 → http://${HOST}:${PORT}`));