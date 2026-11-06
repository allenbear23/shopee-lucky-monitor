#!/usr/bin/env node
// ============================================================================
// Shopee 幸運蝦轉盤 監視器 (線上監視 + Bark 推播)
// ----------------------------------------------------------------------------
// 事件 : https://games.shopee.tw/sellerlck/event/1851933cb3be1af7
// 目的 : 「大量出現非 1 活動蝦幣獎項(券/10幣)」時，用 Bark 通知
//
// 設計要點（對應實測到的 feed 特性）：
//   1. 中獎榜有多份後端副本，各副本 lag 3秒~7分鐘不等。
//      → burst 統計永遠以「lucky_time 落在最近 N 秒」來錨定，
//        舊副本只會讓時間窗變空，不會誤報。
//   2. 時間窗內總中獎數 < --min-winners 就不判斷（避免空窗/非常態）。
//   3. 同一波 burst 有冷卻時間，不重複轟炸（--cooldown）。
//   4. 抓取連續失敗會 Bark 一次（不大聲就等於沒有監視）。
//
// 跨期接續（賣場每天開新一期，event id / draw module 每天換）：
//   A. 同一 event id 滾到新一天，或同一 module 的 feed 恢復滾動 → 自動接上
//   B. FB 社團情報：賣場每天在 FB 社團（shopeechoicetw / ShopeeGames）公告轉盤，
//      貼文 meta 免登入可讀，從內文找 games.shopee.tw 直連或 s.shopee.tw 短網址
//      → 解析出 event id 自動接上；只有賣場頁連結就 Bark 提醒餵連結
//   C. 搜尋引擎（DDG-lite）掃公開分享連結，且用「Template 資產雜湊」過濾，
//      只接同一個 campaign（避免誤接別家店）
//   D. 手動餵入：把 event id / 遊戲網址 / s.shopee.tw 短網址寫進 manual-target.txt
//      （或用 bash feed-link.sh "<連結>"），任一輪或待機掃描自動接管
//
// 用法：
//   BARK_KEY=xxxxxxxx node monitor.mjs                     # 預設每 30s 輪詢
//   node monitor.mjs --bark-key xxxx --interval 15 --test  # 送測試通知
//   node monitor.mjs --fb-check                            # 偵錯：跑一輪 FB 情報偵測
//   可調參數見下方 DEFAULT
// ============================================================================

import { setTimeout as sleep } from "node:timers/promises";
import { appendFileSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import readline from "node:readline";

// 目前監視目標（可跨期動態更換：--event / --url 指定，或待機時由搜尋發現自動切換）
let EVENT = "1851933cb3be1af7";
let DRAWMOD = 391057; // Service.LUCKY_DRAW module_id（每個 event 不同，切換時會重新解析）
let MODULE_ONLY = false; // true = 只知 module、不知 event id（靠 module 掃描自動接期）
let moduleCursor = 0;    // module 掃描游標（從上次已知 module 往上找）
const TARGET_FILE = "target.json"; // 記住目前監視目標，重啟不遺失
const APPID = "9bv5119Po61HKw0Tdn"; // 從前端 bundle 解出的 appid
const DATA_FILE = "feed-data.jsonl"; // 每輪統計 → 供 dashboard 讀取畫圖
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const feedUrl = () => `https://games.shopee.tw/gameplatform/api/v2/goluckydraw/prize/list/module/${DRAWMOD}?appid=${APPID}&offset=%d&limit=100`;
const settingsUrlOf = (id) => `https://games.shopee.tw/gameplatform/api/v1/game/settings/event/${id}?appid=${APPID}`;
const extractEventId = (s) => { const m = String(s || "").match(/sellerlck\/event\/([0-9a-f]{8,})/i); return m ? m[1].toLowerCase() : null; };

const DEFAULT = {
  interval: 30, // 輪詢間隔(秒)
  window: 180, // burst 統計時間窗(秒)
  burst: 12, // 窗內「非1幣」中獎 ≥ 此值 → 觸發
  frac: 0.9, // 窗內「非1幣」佔比 ≥ 此值 → 觸發（目前只以此為準）
  minWinners: 20, // 窗內總中獎必須 ≥ 此值才判斷（防空窗/舊副本）
  cooldown: 600, // 同一波 burst 不重複通知(秒)
  freshLag: 240, // feed 最新一筆落後超過此秒數 → 標 stale（僅記錄）
  rows: 300, // 每次抓最新幾筆（API 單頁上限 100 → 3 頁）
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return def;
}
const CFG = {
  ...DEFAULT,
  interval: +arg("interval", DEFAULT.interval),
  window: +arg("window", DEFAULT.window),
  burst: +arg("burst", DEFAULT.burst),
  frac: +arg("frac", DEFAULT.frac),
  minWinners: +arg("min-winners", DEFAULT.minWinners),
  cooldown: +arg("cooldown", DEFAULT.cooldown),
  freshLag: +arg("fresh-lag", DEFAULT.freshLag),
  rows: +arg("rows", DEFAULT.rows),
  barkKey: arg("bark-key", process.env.BARK_KEY || ""),
  barkUrl: arg("bark-url", process.env.BARK_URL || "https://api.day.app"),
  ttl: +arg("ttl", process.env.BARK_TTL || 600), // 通知在手機上保留秒數(-> 分, Bark ttl 單位=秒)
  test: process.argv.includes("--test"),
  once: process.argv.includes("--once"),
  // 24/7 模式：活動結束不退出，待機並自動偵測「新一天的新場次」再繼續盯
  keepAlive: process.argv.includes("--keep-alive"),
  noDiscover: process.argv.includes("--no-discover"), // 關閉「待機時搜尋發現新場次」
  noBark: process.argv.includes("--no-bark"), // 只收集資料、不推播（給本機圖表用，通知交給雲端）
  menu: process.argv.includes("--menu"),
  setup: process.argv.includes("--setup"),
  chart: !process.argv.includes("--no-chart"),
};

// 終端 ASCII 折線圖
const chartHist = []; // [{t, total, non, frac}]
function sparkline(data, maxW = 40) {
  if (!data.length) return "";
  const vals = data.slice(-maxW);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  return vals.map(v => {
    const idx = Math.floor(((v - min) / range) * (blocks.length - 1));
    return blocks[idx];
  }).join("");
}

function drawChart() {
  if (!chartHist.length) return;
  const recent = chartHist.slice(-60);
  const fracVals = recent.map(x => x.frac);
  const totalVals = recent.map(x => x.total);
  const last = recent[recent.length - 1];
  console.log("");
  console.log(`  ${color(C.cyan, "非1幣佔比")} ${color(C.red, last.frac.toFixed(1) + "%")}  ${color(C.dim, "|")}  ${color(C.cyan, "中獎數")} ${color(C.green, last.total)}`);
  console.log(`  ${color(C.dim, "佔比")} ${color(C.red, sparkline(fracVals))}`);
  console.log(`  ${color(C.dim, "數量")} ${color(C.green, sparkline(totalVals))}`);
  console.log(color(C.dim, `  └─ 過去 ${recent.length} 輪（每 ${CFG.interval}s）`) + C.reset);
}
const MENU_ITEMS = [
  { key: "interval", label: "每幾秒抓一次 (秒)", min: 5, step: 5 },
  { key: "window", label: "統計時間窗 (秒)", min: 30, step: 30 },
  { key: "min-winners", label: "最少中獎人數才判斷", min: 1, step: 1 },
  { key: "frac", label: "非1幣佔比門檻 (0~1)", min: 0.1, step: 0.1, dec: 1 },
  { key: "cooldown", label: "同一波冷卻 (秒)", min: 0, step: 60 },
];

function menuValue(item) {
  const v = CFG[item.key];
  if (item.dec != null) return v.toFixed(item.dec);
  return String(v);
}

function drawMenu(selected) {
  console.clear();
  console.log(C.bold + "╔══════════════════════════════════════════╗" + C.reset);
  console.log(C.bold + "║" + C.cyan + "      Shopee 監控 - 參數調整選單" + " ".repeat(23) + C.bold + "║" + C.reset);
  console.log(C.bold + "╚═══════════════════════════════════════════╝" + C.reset);
  console.log("\n  方向鍵 ↑↓ 選項　←→ 調整數值　Enter 開始監控　q 離開\n");
  MENU_ITEMS.forEach((item, i) => {
    const invert = i === selected ? C.invert : "";
    const val = color(item.dec != null ? C.magenta : C.green, menuValue(item));
    console.log(`  ${i === selected ? "▶" : "  "} ${invert}${C.bold}${item.label}${C.reset}: ${val}${C.reset}`);
  });
  const actInvert = selected === MENU_ITEMS.length ? C.invert : "";
  const exInvert = selected === MENU_ITEMS.length + 1 ? C.invert : "";
  console.log(`  ${actInvert}${C.bold}啟動監控${C.reset}`);
  console.log(`  ${exInvert}${C.bold}離開${C.reset}`);
  console.log(`\n  Bark ${CFG.noBark ? color(C.magenta, "off") : color(C.green, "on")}｜${CFG.keepAlive ? color(C.green, "keep-alive on") : ""}`);
}

let menuRawRestored = false;
function restoreStdin() {
  if (menuRawRestored) return;
  try { process.stdin.setRawMode(false); process.stdin.pause(); } catch {}
  menuRawRestored = true;
}

async function runMenu() {
  if (!process.stdout.isTTY) {
    return runMenuText();
  }
  let selected = 0;
  drawMenu(selected);

  await new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onKey = (ch) => {
      if (ch === "\x1b[A") { // 上
        selected = (selected - 1 + MENU_ITEMS.length + 2) % (MENU_ITEMS.length + 2);
        drawMenu(selected);
        return;
      }
      if (ch === "\x1b[B") { // 下
        selected = (selected + 1) % (MENU_ITEMS.length + 2);
        drawMenu(selected);
        return;
      }
      if (ch === "q" || ch === "Q") {
        restoreStdin();
        process.exit(0);
      }
      if (ch === "\r" || ch === "\n") {
        restoreStdin();
        if (selected === MENU_ITEMS.length + 1) process.exit(0);
        resolve(selected);
        return;
      }
      if (ch === "\x1b[C") { // 右 → 增加
        const item = MENU_ITEMS[selected];
        if (item) {
          let v = CFG[item.key] + item.step;
          if (item.dec != null) v = Math.round(v * 10) / 10;
          CFG[item.key] = v;
        }
        drawMenu(selected);
        return;
      }
      if (ch === "\x1b[D") { // 左 �� 減少
        const item = MENU_ITEMS[selected];
        if (item) {
          let v = CFG[item.key] - item.step;
          if (v < item.min) v = item.min;
          if (item.dec != null) v = Math.round(v * 10) / 10;
          CFG[item.key] = v;
        }
        drawMenu(selected);
        return;
      }
    };

    process.stdin.on("data", onKey);
  });
}

// 非 TTY 降級：數字選單
async function runMenuText() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  while (true) {
    console.log("\n" + C.bold + "Shopee 監控 - 參數調整" + C.reset);
    console.log(`  1) interval    = ${CFG.interval} 秒`);
    console.log(`  2) window      = ${CFG.window} 秒`);
    console.log(`  3) min-winners = ${CFG.minWinners} 人`);
    console.log(`  4) frac        = ${CFG.frac} (非1幣佔比)`);
    console.log(`  5) cooldown    = ${CFG.cooldown} 秒`);
    console.log(`  6) keep-alive  = ${CFG.keepAlive ? "開啟" : "關閉"}`);
    console.log(`  7) no-bark     = ${CFG.noBark ? "開啟（只收資料）" : "關閉（推播）"}`);
    console.log(`  8) 開始監控`);
    console.log(`  9) 離開`);
    const choice = (await ask("請選擇 (1-9): ")).trim();
    if (choice === "1") {
      const v = (await ask(`interval（目前 ${CFG.interval} 秒）: `)).trim();
      if (v) CFG.interval = Math.max(5, +v || CFG.interval);
    } else if (choice === "2") {
      const v = (await ask(`window（目前 ${CFG.window} 秒）: `)).trim();
      if (v) CFG.window = Math.max(30, +v || CFG.window);
    } else if (choice === "3") {
      const v = (await ask(`min-winners（目前 ${CFG.minWinners} 人）: `)).trim();
      if (v) CFG.minWinners = Math.max(1, +v || CFG.minWinners);
    } else if (choice === "4") {
      const v = (await ask(`frac（目前 ${CFG.frac}，例如 0.9）: `)).trim();
      if (v) CFG.frac = Math.min(1, Math.max(0, +v || CFG.frac));
    } else if (choice === "5") {
      const v = (await ask(`cooldown（目前 ${CFG.cooldown} 秒）: `)).trim();
      if (v) CFG.cooldown = Math.max(0, +v || CFG.cooldown);
    } else if (choice === "6") {
      CFG.keepAlive = !CFG.keepAlive;
      console.log(`keep-alive 已${CFG.keepAlive ? "開啟" : "關閉"}`);
    } else if (choice === "7") {
      CFG.noBark = !CFG.noBark;
      console.log(`no-bark 已${CFG.noBark ? "開啟（只收資料）" : "關閉（推播）"}`);
    } else if (choice === "8") {
      rl.close();
      break;
    } else if (choice === "9" || choice === "q" || choice === "exit") {
      rl.close();
      process.exit(0);
    } else {
      console.log("無效選項");
    }
  }
}

// ----------------------------------------------------------------------------
// 首次設定精靈（--setup）：互動式引導，設定 Bark key、目標、參數
async function runSetup() {
  // 讀取所有輸入（TTY 或 pipe 都適用）
  const allLines = [];
  if (process.stdin.isTTY) {
    // 互動式：逐行詢問
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a)));
    // Bark key
    console.log("\n\x1b[1m╔══════════════════════════════════════════╗");
    console.log("║            Shopee 監控 - 首次設定精靈        ║");
    console.log("╚══════════════════════════════════════════╝\x1b[0m\n");
    const key = (await ask("Bark 推播金鑰（留空跳過）: ")).trim();
    if (key) { try { writeFileSync("bark-key.txt", key); } catch {} console.log("  ✓ 已儲存 Bark key 至 bark-key.txt"); }
    else console.log("  ⚠ 未設定 Bark key，僅收集資料模式");
    const tgt = (await ask("轉盤連結或 module id（留空自動偵測）: ")).trim();
    if (tgt) {
      try {
        if (/^\d{5,9}$/.test(tgt)) {
          writeFileSync("target.json", JSON.stringify({ event: "", drawmod: +tgt, moduleCursor: +tgt + 1, savedAt: Math.floor(Date.now()/1000) }, null, 2));
        } else {
          let id = (tgt.match(/[0-9a-f]{16,}/i) || [])[0]?.toLowerCase();
          if (!id) id = (tgt.match(/sellerlck\/event\/([0-9a-f]{8,})/i) || [])[1]?.toLowerCase();
          if (id) { writeFileSync("manual-target.txt", tgt); console.log("  ✓ 已寫入 manual-target.txt"); }
          else console.log("  ⚠ 無法解析連結");
        }
      } catch (e) { console.log("  ⚠ 寫入失敗: " + e.message); }
    } else console.log("  ⚠ 未設定目標，啟動後自動掃描");
    const interval = (await ask("輪詢間隔秒數 (預設 30): ")).trim();
    if (interval) CFG.interval = Math.max(5, +interval || 30);
    const window = (await ask("統計時間窗秒數 (預設 180): ")).trim();
    if (window) CFG.window = Math.max(30, +window || 180);
    const frac = (await ask("非1幣佔比門檻 (0~1, 預設 0.9): ")).trim();
    if (frac) CFG.frac = Math.min(1, Math.max(0, +frac || 0.9));
    const minW = (await ask("最少中獎人數 (預設 20): ")).trim();
    if (minW) CFG.minWinners = Math.max(1, +minW || 20);
    const ka = (await ask("活動結束後自動待機接新場次? (y/N): ")).trim().toLowerCase();
    CFG.keepAlive = ka === "y" || ka === "yes";
    rl.close();
  } else {
    // pipe 模式：讀取全部行
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) allLines.push(line);
    const [key, tgt, interval, window, frac, minW, ka] = allLines;
    if (key && key.trim()) { try { writeFileSync("bark-key.txt", key.trim()); } catch {} console.log("  ✓ 已儲存 Bark key"); }
    if (tgt && tgt.trim()) {
      const t = tgt.trim();
      if (/^\d{5,9}$/.test(t)) writeFileSync("target.json", JSON.stringify({ event: "", drawmod: +t, moduleCursor: +t + 1, savedAt: Math.floor(Date.now()/1000) }, null, 2));
      else writeFileSync("manual-target.txt", t);
    }
    if (interval && interval.trim()) CFG.interval = Math.max(5, +interval || 30);
    if (window && window.trim()) CFG.window = Math.max(30, +window || 180);
    if (frac && frac.trim()) CFG.frac = Math.min(1, Math.max(0, +frac || 0.9));
    if (minW && minW.trim()) CFG.minWinners = Math.max(1, +minW || 20);
    CFG.keepAlive = (ka || "").trim().toLowerCase() === "y";
  }
  console.log("\n\x1b[1m設定摘要：\x1b[0m");
  console.log(`  interval    = ${CFG.interval} 秒`);
  console.log(`  window      = ${CFG.window} 秒`);
  console.log(`  frac        = ${CFG.frac} (非1幣佔比門檻)`);
  console.log(`  min-winners = ${CFG.minWinners} 人`);
  console.log(`  keep-alive  = ${CFG.keepAlive ? "開啟" : "關閉"}`);
  console.log("\n設定完成！執行以下指令開始監控：");
  console.log("  node monitor.mjs --keep-alive" + (process.argv.includes("--no-bark") ? "" : ""));
}

// ----------------------------------------------------------------------------
// 監視目標解析：優先序 --event/--url > 環境變數 > target.json（上次記住的）> 內建預設
function loadTarget() {
  try {
    const j = JSON.parse(readFileSync(TARGET_FILE, "utf8"));
    if (j.event) { EVENT = String(j.event).toLowerCase(); MODULE_ONLY = false; }
    else if (j.drawmod) { MODULE_ONLY = true; }
    if (j.drawmod) DRAWMOD = +j.drawmod;
    if (j.moduleCursor) moduleCursor = +j.moduleCursor;
  } catch {}
}
function saveTarget() {
  try { writeFileSync(TARGET_FILE, JSON.stringify({ event: MODULE_ONLY ? "" : EVENT, drawmod: DRAWMOD, moduleCursor, savedAt: Math.floor(now()) }, null, 2)); } catch {}
}
loadTarget();
try { const k = readFileSync("bark-key.txt", "utf8").trim(); if (k && !CFG.barkKey) CFG.barkKey = k; } catch {}
const cliEventId =
  extractEventId(arg("url", process.env.EVENT_URL || "")) ||
  (arg("event", process.env.EVENT || "").toLowerCase() || null);
const TARGET_OVERRIDDEN = !!cliEventId;
if (cliEventId) EVENT = cliEventId;
const isNonCoin = (r) => r.package_name !== "1 活動蝦幣"; // 券 + 10幣 都算
const now = () => Date.now() / 1000;
const fmt = (t) => new Date(t * 1000).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

let lastAlert = 0;
let failStreak = 0;
let announcedEnd = false;
let feedMode = false;      // true = event id 已換（舊 id 顯示結束但 feed 仍在滾），改以 feed 活動判斷
let staleCycles = 0;       // feed 模式：連續幾輪沒有新鮮中獎
let sawActive = false;     // 這次啟動是否真的監視過進行中的活動（避免剛啟動就對「已結束」補發通知）
let idleScanCount = 0;     // 待機掃描次數（搜尋發現每 3 次跑一次）
const ACTIVE_LAG = 120;    // feed「正在滾動」判定：最新中獎距今 ≤ 此秒數才算新場次（原本 900 太寬會誤判）
const FEED_END_LAG = 1800; // feed 模式：落後 > 此秒數（30 分）→ 視為本場結束

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  invert: "\x1b[7m",
};
function color(code, s) { return process.stdout.isTTY ? `${code}${s}${C.reset}` : s; }
function tag(name, code) { return `[${color(code, name)}]`; }

function log(msg) {
  const line = `[${new Date().toLocaleTimeString("zh-TW", { hour12: false })}] ${msg}`;
  console.log(line);
  try { appendFileSync("monitor.log", line.replace(/\x1b\[[0-9;]*m/g, "") + "\n"); } catch {}
}

// 每輪統計寫入 JSONL（dashboard 讀取畫圖）；過大時裁掉舊資料
function pushData(obj) {
  try {
    appendFileSync(DATA_FILE, JSON.stringify(obj) + "\n");
    const st = statSync(DATA_FILE);
    if (st.size > 8 * 1024 * 1024) {
      const lines = readFileSync(DATA_FILE, "utf8").split("\n");
      writeFileSync(DATA_FILE, lines.slice(-40000).join("\n"));
    }
  } catch {}
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: `https://games.shopee.tw/sellerlck/event/${EVENT}` } });
  const txt = await r.text();
  if (!r.ok || !txt.startsWith("{")) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 150)}`);
  return JSON.parse(txt);
}

async function fetchRecent(maxAttempts = 3) {
  // feed 有多份副本，lag 3s~7min 不等。
  // 最多嘗試 maxAttempts 次，取「最新一筆 lucky_time 最接近現在」的快照。
  let best = { rows: [], lag: Infinity };
  for (let a = 0; a < maxAttempts; a++) {
    const pages = Math.ceil(CFG.rows / 100);
    const seen = new Set();
    const rows = [];
    for (let p = 0; p < pages; p++) {
      const data = (await getJson(feedUrl().replace("%d", String(p * 100)))).data || [];
      for (const r of data) {
        const k = `${r.id}:${r.user_id}:${r.lucky_time}`;
        if (!seen.has(k)) { seen.add(k); rows.push(r); }
      }
      if (data.length < 100) break;
    }
    if (!rows.length) return best;
    const lag = now() - Math.max(...rows.map((r) => r.lucky_time));
    if (lag < best.lag) best = { rows, lag };
    if (lag <= CFG.freshLag) break; // 夠新，不用再試
    if (a < maxAttempts - 1) await sleep(2000);
  }
  return best;
}

async function sendBark(title, body, group = "shopee-lucky") {
  if (CFG.noBark) return false; // 資料收集模式：不推播（通知由雲端負責）
  if (!CFG.barkKey) { log(`⚠ 未設定 BARK_KEY，無法推播。\n  title=${title}\n  body=${body}`); return false; }
  const url = `${CFG.barkUrl}/${encodeURIComponent(CFG.barkKey)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${group}&isArchive=1&ttl=${CFG.ttl}`;
  try {
    const r = await fetch(url);
    const t = await r.text();
    log(`📲 Bark 已送出 (${r.status}) ${t.slice(0, 120)}`);
    if (r.ok) pushData({ t: now(), type: "alert", title, body: body.slice(0, 300), group });
    return r.ok;
  } catch (e) {
    log(`❌ Bark 送出失敗: ${e.message}`);
    return false;
  }
}

async function getEventStatus(id = EVENT) {
  // 只讀活動狀態，不做任何通知副作用（通知統一在 oneCycle 處理）
  const d = (await getJson(settingsUrlOf(id))).data;
  const left = d.basic.end_time - now();
  return { ended: left < 0, left, end: fmt(d.basic.end_time), data: d };
}

// ----------------------------------------------------------------------------
// 跨期接續：解析新 event 的 draw module、切換目標、搜尋發現新場次
// ----------------------------------------------------------------------------
async function resolveDrawModule(id) {
  const d = (await getJson(settingsUrlOf(id))).data;
  const m = (d.modules || []).find((x) => x.module_name === "Service.LUCKY_DRAW");
  return m ? m.module_id : null;
}

async function switchEvent(id, reason) {
  const mod = await resolveDrawModule(id);
  if (!mod) throw new Error("該 event 的 settings 找不到 Service.LUCKY_DRAW module");
  EVENT = id;
  DRAWMOD = mod;
  MODULE_ONLY = false;
  moduleCursor = DRAWMOD + 1;
  saveTarget();
  announcedEnd = false;
  feedMode = false;
  staleCycles = 0;
  sawActive = false;
  lastAlert = 0;
  log(`🎯 切換監視目標 → event ${EVENT} / module ${DRAWMOD}（${reason}）`);
}

// 只拿到 module（沒有 event id）時切換：直接以 feed 模式監視
async function switchModule(mod, reason) {
  DRAWMOD = +mod;
  MODULE_ONLY = true;
  moduleCursor = DRAWMOD + 1;
  saveTarget();
  announcedEnd = false;
  feedMode = true;
  staleCycles = 0;
  sawActive = true;
  lastAlert = 0;
  log(`🎯 切換監視目標 → module ${DRAWMOD}（${reason}；event id 未知，走 feed 模式）`);
}

// ----------------------------------------------------------------------------
// module 掃描：event id 只存在於 app 分享連結，公開網路拿不到；但 Service.LUCKY_DRAW
// 的 module_id 是連續配發，且 feed endpoint 不需要 event id。從上次已知 module 往上
// 掃，用「feed 新鮮 + 本店獎項特徵（1 活動蝦幣）」找出新場次，直接以 feed 模式接上。
// ----------------------------------------------------------------------------
async function discoverActiveModule() {
  const base = +DRAWMOD || 0;
  if (!base) return null;
  if (moduleCursor < base + 1) moduleCursor = base + 1;
  const end = base + 10000;
  const stop = Math.min(moduleCursor + 39, end); // 每輪掃 40 個，分散請求
  for (let id = moduleCursor; id <= stop; id++) {
    moduleCursor = id + 1;
    try {
      const r = await fetch(`https://games.shopee.tw/gameplatform/api/v2/goluckydraw/prize/list/module/${id}?appid=${APPID}&offset=0&limit=10`, {
        headers: { "User-Agent": UA, Referer: "https://games.shopee.tw/sellerlck/" },
      });
      if (!r.ok) { if (r.status === 403 || r.status === 429) { moduleCursor = base + 1; break; } continue; }
      const j = await r.json().catch(() => null);
      const rows = (j && j.data) || [];
      if (!rows.length) continue;
      const latest = Math.max(...rows.map((x) => x.lucky_time || 0));
      if (now() - latest > ACTIVE_LAG) continue;
      if (!rows.some((x) => x.package_name === "1 活動蝦幣")) continue;
      try { saveTarget(); } catch {}
      return id;
    } catch {}
    await sleep(250);
  }
  if (moduleCursor > end) moduleCursor = base + 1; // 掃完一輪，下輪從頭（保留游標而非歸零）
  try { saveTarget(); } catch {}
  return null;
}

// ----------------------------------------------------------------------------
// 手動餵連結：把 event id / games URL / s.shopee.tw 短網址寫進 manual-target.txt，
// 監視器任一輪或待機掃描時自動接管（成功後清空檔案）
// ----------------------------------------------------------------------------
function manualTargetText() {
  try { return readFileSync("manual-target.txt", "utf8").trim(); } catch { return ""; }
}
function clearManualTarget() {
  try { writeFileSync("manual-target.txt", ""); } catch {}
}
function fbDecode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<");
}
async function resolveShortLink(code) {
  const r = await fetch(`https://s.shopee.tw/${code}`, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const t = await r.text();
  const m = t.match(/httpUrl:\s*"([^"]+)"/);
  if (!m) return null;
  const url = fbDecode(m[1]).replace(/\\\//g, "/");
  const idM = url.match(/sellerlck\/event\/([0-9a-f]{8,})/i);
  return { url, event: idM ? idM[1].toLowerCase() : null, isStore: /shopee_choice_hl/.test(url) };
}
async function handleManualTarget(reason) {
  try {
    const txt = manualTargetText();
    if (!txt) return false;
    // 純數字 = 直接指定 module id（沒有 event id 也能監視）
    if (/^\d{5,9}$/.test(txt)) {
      clearManualTarget();
      await switchModule(+txt, "手動餵入 module（" + reason + "）");
      log(`🆕 手動接管 module ${DRAWMOD}（event id 未知，feed 模式）`);
      await sendBark("🆕 已接管手動指定的 module", "已接上 module " + DRAWMOD + "（event id 未知，feed 模式）。");
      return true;
    }
    let id = (txt.match(/[0-9a-f]{16,}/i) || [])[0]?.toLowerCase(); // 直接 event id
    if (!id) id = extractEventId(txt);
    if (!id) {
      const code = (txt.match(/s\.shopee\.tw\/([A-Za-z0-9]{8,})/i) || [])[1];
      if (code) { const info = await resolveShortLink(code); id = info?.event || null; }
    }
    if (!id) { log(`⚠ manual-target.txt 內容無法解析為 event/link：${txt.slice(0, 60)}`); return false; }
    clearManualTarget();
    await switchEvent(id, "手動餵入（" + reason + "）");
    log(`🆕 手動接管新場次 event ${EVENT} / module ${DRAWMOD}`);
    await sendBark("🆕 已接管手動指定的場次", "已自動解析並接上 event " + EVENT + "（module " + DRAWMOD + "）。");
    return true;
  } catch { return false; }
}

async function oneCycle() {
  try {
    // 手動餵入的目標優先接管（貼進 manual-target.txt，任一輪就會接上）
    try { if (await handleManualTarget("輪詢中")) return "ok"; } catch {}
    if (MODULE_ONLY) feedMode = true; // 只有 module：以 feed 新鮮度判斷場次
    const { rows, lag } = await fetchRecent();
    const feedFresh = rows.length > 0 && lag <= ACTIVE_LAG; // feed 是否「正在滾動」

    // 活動狀態：以 settings 為準；若舊 event id 已結束、但 feed 仍在滾 → 換場次（新 id）轉 feed 模式
    let left = null;
    if (!feedMode) {
      const st = await getEventStatus();
      if (st.ended) {
        if (!feedFresh) {
          if (sawActive && !announcedEnd) {
            announcedEnd = true;
            await sendBark(
              "🎉 活動已結束",
              "幸運蝦轉盤已於 " + st.end + " 結束。" +
              (CFG.keepAlive ? "進入 24h 待機，偵測到新場次會自動接上並通知。" : "停止監視。")
            );
          }
          return "ended";
        }
        // 舊 id 仍顯示結束，但 feed 恢復滾動 → 新場次（新 event id）
        feedMode = true;
        announcedEnd = false;
        sawActive = true;
        log("🆕 舊 event id 仍顯示結束，但 feed 恢復滾動 → 改用 feed 追蹤新場次");
        await sendBark("🆕 幸運蝦轉盤新場次開跑", "中獎榜恢復滾動（新的 event id）。監視器已自動接上。");
      } else {
        left = st.left;
        sawActive = true;
      }
    }

    if (!rows.length) {
      if (++failStreak === 3) await sendBark("⚠ 監視器抓不到資料", "連續 3 輪 feed 為空，請檢查網路。");
      log(`⚠ feed 回空（連續 ${failStreak} 次）`);
      return "err";
    }
    failStreak = 0;

    const stale = lag > CFG.freshLag ? ` ⚠STALE(lag=${Math.round(lag)}s)` : "";
    const inWin = rows.filter((r) => r.lucky_time > now() - CFG.window);
    const total = inWin.length;
    const uniqUsers = new Set(inWin.map((r) => r.user_id).filter(Boolean)).size;
    const non = inWin.filter(isNonCoin);
    const nCoin1 = inWin.filter((r) => r.package_name === "1 活動蝦幣").length;
    const n30 = inWin.filter((r) => r.package_name.includes("30")).length;
    const n50 = inWin.filter((r) => r.package_name.includes("50")).length;
    const n100 = inWin.filter((r) => r.package_name.includes("100")).length;
    const nCoin10 = inWin.filter((r) => isNonCoin(r) && r.prize_type === 2).length;
    const frac = total ? (non.length / total) * 100 : 0;
    const leftMin = left == null ? null : Math.round(left / 60);

    const lagColor = lag <= CFG.freshLag ? C.green : lag <= CFG.freshLag * 3 ? C.yellow : C.red;
    const fracColor = frac >= CFG.frac * 100 ? C.red : C.green;
    const modeColor = feedMode ? C.magenta : C.blue;
    const modeLabel = feedMode ? "feed模式" : `距結束≈${leftMin == null ? "?" : leftMin}分`;
    const bar = "█".repeat(Math.min(20, Math.round((frac / 100) * 20))).padEnd(20);
    log(
      `${color(C.cyan, `lag=${Math.round(lag)}s`)}` +
      `${stale ? color(C.yellow, " ⚠STALE") : ""}` +
      ` | 近${CFG.window}s: ${color(C.green, total)}中獎（獨立用戶 ${color(C.green, uniqUsers)}）` +
      ` 非1幣=${color(fracColor, non.length)}(${color(fracColor, frac.toFixed(1))}%) ${color(C.dim, bar)}` +
      ` [1幣${nCoin1}/30券${n30}/50券${n50}/100券${n100}/10幣${nCoin10}]` +
      ` | ${color(modeColor, modeLabel)}`
    );

    // burst 判斷
    const enough = total >= CFG.minWinners;
    // 只有「非1幣佔比 ≥ 門檻（預設 90%）」才通知；不再用筆數門檻
    const hit = enough && frac >= CFG.frac * 100;
    let alerted = 0;
    if (hit && now() - lastAlert >= CFG.cooldown) {
      lastAlert = now();
      const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : "0.0");
      // 機率基準：用這次抓回的全部中獎列（近數分鐘、不重複）當「平時」基準
      const baseTotal = rows.length;
      const baseNon = rows.filter(isNonCoin).length;
      const baseFrac = baseTotal ? (baseNon / baseTotal) * 100 : 0;
      const ratioTxt = baseFrac > 0 ? (frac / baseFrac).toFixed(1) : "?";
      const title = `🔥 非1幣率 ${frac.toFixed(1)}%（平時 ${baseFrac.toFixed(1)}%，${ratioTxt}×）`;
      const body =
        `近${CFG.window}秒 ${total} 人中獎，非1幣 ${non.length} 筆＝${frac.toFixed(1)}%` +
        `（平時約 ${baseFrac.toFixed(1)}%，現在 ${ratioTxt} 倍）\n` +
        `各獎率：1幣 ${pct(nCoin1)}%｜30券 ${pct(n30)}%｜50券 ${pct(n50)}%｜100券 ${pct(n100)}%｜10幣 ${pct(nCoin10)}%\n` +
        `※ 機率＝中獎者中該獎的佔比（中獎榜只列中獎者）\n` +
        `feed落後${Math.round(lag)}s，離結束≈${leftMin == null ? "?" : leftMin}分`;
      await sendBark(title, body);
      alerted = 1;
    }
    pushData({
      t: now(), mode: "active",
      lag: Math.round(lag), stale: stale ? 1 : 0,
      win: CFG.window, total, non: non.length, frac: +frac.toFixed(1), uniq: uniqUsers,
      n1: nCoin1, n30, n50, n100, n10: nCoin10,
      leftMin, alert: alerted,
    });
    if (CFG.chart) {
      chartHist.push({ t: now(), total, non: non.length, frac: +frac.toFixed(1) });
      if (chartHist.length > 200) chartHist.splice(0, chartHist.length - 200);
      drawChart();
    }

    // feed 模式：靠 feed 新鮮度判斷本場是否結束（連續多輪落後超過門檻）
    if (feedMode) {
      if (lag <= FEED_END_LAG) staleCycles = 0;
      else if (++staleCycles >= 3) {
        log(`🎉 feed 停止滾動（落後 ${Math.round(lag)}s）→ 本場結束，進入待機`);
        feedMode = false;
        staleCycles = 0;
        announcedEnd = false;
        return "ended";
      }
    }
    return "ok";
  } catch (e) {
    if (++failStreak === 3) await sendBark("⚠ 監視器連線失敗", e.message.slice(0, 200));
    log(`❌ 本輪失敗: ${e.message.slice(0, 160)}（連續 ${failStreak}）`);
    return "err";
  }
}

// ----------------------------------------------------------------------------
// 24/7 待機：定時掃描「新一天的新場次」
// 偵測方式 1: 同一個 event ID 的 settings 滾到新的一天（begin_time 是今天）
// 偵測方式 2: 中獎榜 feed 恢復滾動（event ID 每天換的場合，靠 feed 判斷即可）
async function idleScan() {
  while (true) {
    await sleep(300_000); // 每 5 分鐘掃一次
    try {
      // 1) 同一 event 是否滾到新的一天（module-only 模式沒有 event id，跳過）
      if (!MODULE_ONLY) try {
        const st = await getEventStatus();
        if (!st.ended) {
          announcedEnd = false;
          feedMode = false;
          const begin = st.data?.basic?.begin_time;
          log(`🆕 偵測到新場次（同一 event id，${fmt(begin)} 開始，結束 ${st.end}）`);
          await sendBark("🆕 幸運蝦轉盤新場次開跑", `${fmt(begin)} 開跑，結束 ${st.end}。監視器已自動接上。`);
          return;
        }
      } catch { /* event id 失效 → 走 feed 偵測 */ }
      // 2) feed 是否真的在滾（必須夠新鮮；舊場次殘留的中獎不算）
      const { rows, lag } = await fetchRecent(1);
      if (rows.length && lag <= ACTIVE_LAG) {
        announcedEnd = false;
        failStreak = 0;
        feedMode = true;
        log(`🆕 偵測到新場次（feed 恢復滾動，event ID 未知，lag=${Math.round(lag)}s）`);
        await sendBark("🆕 偵測到新場次開跑", "中獎榜開始滾動（新的一天活動）。監視器已自動接上。");
        return;
      }
      log("⏳ 待機中…（每 5 分鐘掃描新場次）");
      pushData({ t: now(), mode: "idle" });
      // 3) 手動餵入的目標優先接管
      try { if (await handleManualTarget("待機掃描")) return; } catch {}
      // 3.5) module 掃描：不需要 event id，直接找今天正在滾的 module
      if (!CFG.noDiscover) {
        try {
          const mod = await discoverActiveModule();
          if (mod) {
            await switchModule(mod, "module 掃描發現新場次");
            log(`🆕 module 掃描發現新場次 module ${mod}（event id 未知，feed 模式）`);
            await sendBark("🆕 幸運蝦轉盤新場次開跑", `module 掃描發現新場次（module ${mod}，event id 未知）。監視器已自動接上。`);
            return;
          }
        } catch (e) { log(`⚠ module 掃描失敗: ${e.message.slice(0, 80)}`); }
      }
      // 4) FB 社團情報（每天開跑的公告管道；每個掃描都跑，貼文清單 15 分鐘才重搜）
      if (!CFG.noDiscover) {
        try {
          const fb = await discoverFromFb();
          if (fb.match) {
            await switchEvent(fb.match.id, "FB 社團發現「" + (fb.match.name || fb.match.from) + "」");
            log(`🆕 FB 社團發現新場次開跑（結束 ${fb.match.end}，剩 ${Math.round(fb.match.left / 60)} 分）`);
            await sendBark("🆕 幸運蝦轉盤新場次開跑", "從賣場社團貼文發現「" + (fb.match.name || fb.match.id) + "」。監視器已自動接上。");
            return;
          }
          if (fb.announced) {
            log("🔔 FB 社團公告轉盤開跑（貼文只有賣場頁連結，無 event id）");
            await sendBark(
              "🔔 賣場社團公告：轉盤開跑了！",
              "貼文：「" + fb.desc.slice(0, 60) + "…」（詳見 FB 社團）。\n若自動偵測抓不到 event id，請在 app 遊戲頁按「分享→複製連結」，然後：\n  echo \"<連結>\" > ~/shopee-sellerlck/manual-target.txt\n監視器 5 分鐘內會自動接上。"
            );
          }
        } catch (e) { log(`⚠ FB 偵測失敗: ${e.message.slice(0, 100)}`); }
      }
      // 5) 搜尋引擎發現新場次（每 3 次掃描跑一次，節制對搜尋引擎的請求）
      idleScanCount++;
      if (!CFG.noDiscover && idleScanCount % 3 === 0) {
        try {
          const res = await discoverNewActiveEvent();
          if (res.match) {
            const ev = res.match;
            await switchEvent(ev.id, "搜尋發現「" + (ev.name || ev.id) + "」");
            log(`🆕 搜尋發現新場次開跑（結束 ${ev.end}，剩 ${Math.round(ev.left / 60)} 分）`);
            await sendBark("🆕 幸運蝦轉盤新場次開跑", "搜尋發現新的活動「" + (ev.name || ev.id) + "」。監視器已自動接上。");
            return;
          }
          if (res.others.length) log(`🔎 發現 ${res.others.length} 個他店場次（模板不符不接）：${res.others.slice(0, 3).map((o) => o.name || o.id).join("、")}…`);
          else log("🔎 搜尋未發現新的進行中場次");
        } catch (e) {
          log(`⚠ 搜尋發現失敗: ${e.message.slice(0, 100)}`);
        }
      }
    } catch (e) {
      log(`❌ 待機掃描失敗: ${e.message.slice(0, 120)}`);
    }
  }
}

// ----------------------------------------------------------------------------
async function main() {
  // 首次執行（無 bark-key.txt 且無 target.json）→ 自動進入設定精靈
  const firstRun = !existsSync("bark-key.txt") && !existsSync("target.json");
  if (firstRun && !CFG.test && !CFG.once && !CFG.setup && !CFG.menu) {
    console.log("\n\x1b[1m╔══════════════════════════════════════════╗");
    console.log("║      首次使用 — 請先完成基本設定            ║");
    console.log("╚══════════════════════════════════════════╝\x1b[0m\n");
    console.log("  此程式需要設定以下項目：");
    console.log("  1. Bark 推播金鑰（可跳過，僅收資料）");
    console.log("  2. 轉盤連結或 module id（可跳過，自動偵測）");
    console.log("  3. 輪詢間隔、統計時間窗等參數\n");
    await runSetup();
    process.exit(0);
  }
  if (CFG.test) {
    log(`測試 Bark → key=${CFG.barkKey ? CFG.barkKey.slice(0, 4) + "…" : "(未設定)"} url=${CFG.barkUrl}`);
    const ok = await sendBark("🧪 監視器測試", "如果收到這則通知表示 Bark 設定正確，之後 burst 才會推播。", "shopee-lucky-test");
    process.exit(ok ? 0 : 1);
  }
  if (process.argv.includes("--fb-check")) {
    const fb = await discoverFromFb();
    log(`FB 偵測結果：match=${fb.match ? fb.match.id + "「" + fb.match.name + "」" : "無"} announced=${fb.announced}${fb.desc ? " desc=" + fb.desc.slice(0, 60) : ""}`);
    process.exit(0);
  }
  // 支援直接貼上轉盤連結切換：--link "https://..." 或 --url
  const cliLink = arg("link", arg("add", "")) || "";
  if (cliLink) {
    try {
      let id = null;
      let mod = null;
      const txt = cliLink.trim();
      if (/^\d{5,9}$/.test(txt)) {
        mod = +txt;
      } else {
        id = (txt.match(/[0-9a-f]{16,}/i) || [])[0]?.toLowerCase();
        if (!id) id = extractEventId(txt);
        if (!id) {
          const code = (txt.match(/s\.shopee\.tw\/([A-Za-z0-9]{8,})/i) || [])[1];
          if (code) { const info = await resolveShortLink(code); id = info?.event || null; }
        }
      }
      if (mod) {
        await switchModule(mod, "手動連結(--link)");
        log(`🎯 已直接接管 module ${DRAWMOD}（--link）`);
      } else if (id) {
        await switchEvent(id, "手動連結(--link)");
        log(`🎯 已直接接管 event ${EVENT} / module ${DRAWMOD}（--link）`);
      } else {
        log(`⚠ --link 無法解析：${txt.slice(0, 80)}`);
      }
    } catch (e) {
      log(`⚠ --link 處理失敗: ${e.message.slice(0, 80)}`);
    }
  }
  if (!CFG.barkKey && !CFG.once && !CFG.noBark && !CFG.menu && !CFG.setup) {
    console.log("\n\x1b[1m╔══════════════════════════════════════════╗");
    console.log("║            尚未設定 Bark 推播金鑰            ║");
    console.log("╚══════════════════════════════════════════╝\x1b[0m\n");
    console.log("  你可以：");
    console.log("  1. 執行設定精靈：node monitor.mjs --setup");
    console.log("  2. 或設定環境變數：BARK_KEY=你的金鑰 node monitor.mjs");
    console.log("  3. 或僅收集資料：node monitor.mjs --no-bark\n");
    console.log("  按 Enter 繼續（僅收資料模式）...");
    // 等待使用者按 Enter
    await new Promise((res) => {
      process.stdin.resume();
      process.stdin.once("data", () => res());
    });
    CFG.noBark = true;
  }
  if (CFG.once) {
    log("🧪 --once 乾跑一輪（不推播、不循環）…");
    log("設定 window=" + CFG.window + "s 通知門檻=非1幣≥" + Math.round(CFG.frac * 100) + "% minWinners=" + CFG.minWinners + " rows=" + CFG.rows);
    await oneCycle();
    process.exit(0);
  }
  if (CFG.setup) {
    await runSetup();
    process.exit(0);
  }
  if (CFG.menu) await runMenu();
  // 手動餵入的目標優先（啟動時就有 manual-target.txt 就直接接管）
  try { if (await handleManualTarget("啟動時")) log(`🎯 啟動時由 manual-target.txt 接管目標`); } catch {}
  // 確保監視目標的 module 正確（target.json / --event / --url 可能換過 event）
  try {
    if (MODULE_ONLY) {
      log(`🎯 監視目標 module ${DRAWMOD}（event id 未知，feed 模式）`);
    } else {
      const mod = await resolveDrawModule(EVENT);
      if (!mod) throw new Error("無 Service.LUCKY_DRAW");
      if (mod !== DRAWMOD) { DRAWMOD = mod; saveTarget(); }
      log(`🎯 監視目標 event ${EVENT} / draw module ${DRAWMOD}` + (TARGET_OVERRIDDEN ? "（--event/--url 指定）" : ""));
    }
  } catch (e) {
    log(`⚠ 目前目標 event ${EVENT} settings 讀取失敗：${e.message.slice(0, 60)}。暫時沿用 module ${DRAWMOD}。`);
  }
  const st = MODULE_ONLY ? null : await getEventStatus().catch(() => null);
  const active = MODULE_ONLY || (st !== null && !st.ended);
  console.log(color(C.bold, "╔═════════════════════════════════════════════════╗"));
  console.log(color(C.bold, "║") + "  " + color(C.cyan, "🎯 幸運蝦轉盤監控已啟動") + " ".repeat(29) + color(C.bold, "║"));
  console.log(color(C.bold, "╠═════════════════════════════════════════════════╣"));
  const targetLine = MODULE_ONLY ? `module ${DRAWMOD} (event id 未知)` : `event ${EVENT} / module ${DRAWMOD}`;
  console.log(color(C.bold, "║") + `  目標：${color(C.yellow, targetLine)}` + " ".repeat(46 - targetLine.length) + color(C.bold, "║"));
  const modeLine = MODULE_ONLY ? "feed模式（event id 未知）" : active ? `活動剩餘 ${Math.round(st.left / 60)} 分（結束 ${st.end}）` : "待機/未知";
  console.log(color(C.bold, "║") + `  模式：${color(C.green, modeLine)}` + " ".repeat(46 - modeLine.length) + color(C.bold, "║"));
  const cfgLine = `非1幣 ≥ ${Math.round(CFG.frac * 100)}% | 最少 ${CFG.minWinners} 人 | 冷卻 ${CFG.cooldown}s | 間隔 ${CFG.interval}s`;
  console.log(color(C.bold, "║") + `  門檻：${color(C.green, cfgLine)}` + " ".repeat(46 - cfgLine.length) + color(C.bold, "║"));
  const statLine = `${CFG.keepAlive ? "keepAlive=on(24h)" : ""} ${CFG.noBark ? "no-bark=on（只收資料）" : ""}`.trim() || "一般模式";
  console.log(color(C.bold, "║") + `  狀態：${color(C.green, statLine)}` + " ".repeat(46 - statLine.length) + color(C.bold, "║"));
  console.log(color(C.bold, "╚═════════════════════════════════════════════════╝"));
  console.log("");
  if (active) {
    await sendBark("📡 監視器上線", `開始監視幸運蝦轉盤，每 ${CFG.interval} 秒一輪。非1幣大量出現時會通知。`);
  } else if (CFG.keepAlive) {
    log("⏳ 目前無進行中場次 → 進入 24h 待機，偵測到新場次開跑會自動接上。");
  }
  // 主迴圈（async while 取代 setInterval，支援待機/長間隔切換）
  while (true) {
    const t0 = Date.now();
    const r = await oneCycle();
    if (r === "ended") {
      if (!CFG.keepAlive) { log("活動結束，監視器退出。"); process.exit(0); }
      log("🎉 本場結束 → 進入 24h 待機（每 5 分鐘掃描新場次）。");
      await idleScan(); // 直到找到新場次才回傳
      continue;
    }
    // 讓「整輪週期」貼齊 interval：睡眠扣除本輪耗時（抓取較久時自動少睡）
    const dt = (Date.now() - t0) / 1000;
    await sleep(Math.max(0, CFG.interval - dt) * 1000);
  }
}

main().catch((e) => { console.error("❌ 啟動失敗", e); process.exit(1); });