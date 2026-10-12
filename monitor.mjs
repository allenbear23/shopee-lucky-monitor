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
import { appendFileSync, readFileSync, writeFileSync, statSync } from "node:fs";

// 目前監視目標（可跨期動態更換：--event / --url 指定，或待機時由搜尋發現自動切換）
let EVENT = "1851933cb3be1af7";
let DRAWMOD = 391057; // Service.LUCKY_DRAW module_id（每個 event 不同，切換時會重新解析）
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
  frac: 0.1, // 窗內「非1幣」佔比 ≥ 此值 → 觸發
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
};

// ----------------------------------------------------------------------------
// 監視目標解析：優先序 --event/--url > 環境變數 > target.json（上次記住的）> 內建預設
function loadTarget() {
  try {
    const j = JSON.parse(readFileSync(TARGET_FILE, "utf8"));
    if (j.event) EVENT = String(j.event).toLowerCase();
    if (j.drawmod) DRAWMOD = +j.drawmod;
  } catch {}
}
function saveTarget() {
  try { writeFileSync(TARGET_FILE, JSON.stringify({ event: EVENT, drawmod: DRAWMOD, savedAt: Math.floor(now()) }, null, 2)); } catch {}
}
loadTarget();
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

function log(msg) {
  const line = `[${new Date().toLocaleTimeString("zh-TW", { hour12: false })}] ${msg}`;
  console.log(line);
  try { appendFileSync("monitor.log", line + "\n"); } catch {}
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
  saveTarget();
  announcedEnd = false;
  feedMode = false;
  staleCycles = 0;
  sawActive = false;
  lastAlert = 0;
  log(`🎯 切換監視目標 → event ${EVENT} / module ${DRAWMOD}（${reason}）`);
}

let OUR_FP = null; // 本活動的品牌指紋（Asset.Template 雜湊＋活動名），用來過濾搜尋發現的場次是不是「這一家」

async function fingerprintEvent(id) {
  const d = (await getJson(settingsUrlOf(id))).data;
  const t = (d.modules || []).find((x) => x.module_name === "Asset.Template");
  let templateCdn = null;
  if (t) {
    try {
      const a = (await getJson(`https://games.shopee.tw/gameplatform/api/v2/asset/list?appid=${APPID}&module_ids=${t.module_id}`)).data;
      templateCdn = a && a[0] ? a[0].cdn : null;
    } catch {}
  }
  return { templateCdn, name: (d.basic?.game_name || "").slice(0, 20) };
}

async function searchEventIds() {
  // DDG-lite 為主（直接給外部連結），Bing RSS 為輔
  const ids = new Set();
  const queries = ["games.shopee.tw sellerlck event", "games.shopee.tw/sellerlck/event", "site:games.shopee.tw sellerlck"];
  for (const q of queries) {
    try {
      const r = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), {
        headers: { "User-Agent": UA, Accept: "text/html" },
      });
      if (r.ok) {
        const html = await r.text();
        for (const m of html.matchAll(/<a[^>]+href="([^"]+)"/g)) {
          const id = extractEventId(m[1]);
          if (id) ids.add(id);
        }
      }
    } catch {}
    await sleep(1500);
  }
  return [...ids];
}

async function discoverNewActiveEvent() {
  // 掃搜尋引擎已知連結：
  //  - 只要「進行中 ＋ Template 雜湊與本活動相同」→ 判定是同一家的新場次，回傳當候選
  //  - 其他進行中的場次（他店）只記錄回報，不自動接
  const ids = await searchEventIds();
  if (!ids.length) return { match: null, others: [] };
  const others = [];
  for (const id of ids) {
    if (id === EVENT) continue;
    try {
      const st = await getEventStatus(id);
      if (st.ended) continue;
      const begin = st.data?.basic?.begin_time || 0;
      if (begin > now() || begin <= 0) continue; // 未開或無效
      const fp = await fingerprintEvent(id);
      const ev = { id, end: st.end, left: st.left, name: fp.name };
      if (OUR_FP && OUR_FP.templateCdn && fp.templateCdn === OUR_FP.templateCdn) {
        return { match: ev, others }; // 同模板 → 很可能是同一家
      }
      others.push(ev);
    } catch {}
    await sleep(400);
  }
  return { match: null, others };
}

// ----------------------------------------------------------------------------
// FB 社團情報偵測：賣場（蝦皮特選/shopee_choice_hl）每天在 FB 社團公告轉盤
//（「每天都要轉轉盤…」+ s.shopee.tw 短網址 / 直連 games.shopee.tw）。貼文 meta
// 免登入即可讀，baby 級流量，每 15 分鐘重新搜尋一次貼文清單。
// ----------------------------------------------------------------------------
const FB_QUERIES = [
  "site:facebook.com/groups/shopeechoicetw 轉盤",
  "site:facebook.com/groups/shopeechoicetw",
  "site:facebook.com/groups/ShopeeGames sellerlck",
];
let fbSeen = new Set();      // 已處理過的貼文 URL
let lastFbSearch = 0;        // 最近一次搜尋貼文清單的時間
const FB_STATE_FILE = "fb-state.json";
let fbAnnouncedDay = "";     // 已通知「公告開跑但缺連結」的台灣日期（持久化：跨重啟不重複轟炸）
try { fbAnnouncedDay = JSON.parse(readFileSync(FB_STATE_FILE, "utf8")).day || ""; } catch {}

function fbDecode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<");
}

async function fbDdgPostUrls() {
  const urls = new Set();
  for (const q of FB_QUERIES) {
    try {
      const r = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), {
        headers: { "User-Agent": UA, Accept: "text/html" },
      });
      if (r.ok) {
        const html = await r.text();
        for (const m of html.matchAll(/<a[^>]+href="([^"]+)"/g)) {
          if (/facebook\.com\/groups\/(shopeechoicetw|ShopeeGames)\/(posts|permalink)\//.test(m[1])) {
            urls.add(m[1].split("?")[0]);
          }
        }
      }
    } catch {}
    await sleep(1200);
  }
  return [...urls];
}

async function fbPostMeta(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return "";
  const t = await r.text();
  const d = (t.match(/<meta[^>]+(?:property|name)="(?:og:description|description)"[^>]+content="([^"]*)"/i) || [])[1] || "";
  return fbDecode(d);
}

async function resolveShortLink(code) {
  // s.shopee.tw 是 JS 著陸頁，內嵌 CONFIG.httpUrl 才是真正目的地
  const r = await fetch(`https://s.shopee.tw/${code}`, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const t = await r.text();
  const m = t.match(/httpUrl:\s*"([^"]+)"/);
  if (!m) return null;
  const url = fbDecode(m[1]).replace(/\\\//g, "/");
  const idM = url.match(/sellerlck\/event\/([0-9a-f]{8,})/i);
  return { url, event: idM ? idM[1].toLowerCase() : null, isStore: /shopee_choice_hl/.test(url) };
}

async function discoverFromFb() {
  // 新貼文清單（每 15 分鐘刷新一次）
  let newPosts = [];
  if (Date.now() - lastFbSearch > 15 * 60 * 1000) {
    lastFbSearch = Date.now();
    const urls = await fbDdgPostUrls();
    newPosts = urls.filter((u) => !fbSeen.has(u));
    newPosts.forEach((u) => fbSeen.add(u));
  }
  if (!newPosts.length) return { match: null, announced: false };
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // Asia/Taipei 日期（用 UTC 會跨日重複通知）
  let announced = false;
  let announcedDesc = "";
  for (const u of newPosts) {
    try {
      const d = await fbPostMeta(u);
      if (!/轉盤|幸運|蝦幣/.test(d)) continue;
      // 直連遊戲連結
      for (const m of d.matchAll(/sellerlck\/event\/([0-9a-f]{8,})/gi)) {
        const id = m[1].toLowerCase();
        const st = await getEventStatus(id);
        if (!st.ended) return { match: { id, end: st.end, left: st.left, name: (st.data?.basic?.game_name || "").slice(0, 16), from: "FB貼文" }, announced, desc: announcedDesc };
      }
      // 短網址（可能指到遊戲頁或賣場頁）
      for (const m of d.matchAll(/s\.shopee\.tw\/([A-Za-z0-9]{8,})/g)) {
        const info = await resolveShortLink(m[1]);
        if (!info) continue;
        if (info.event) {
          const st = await getEventStatus(info.event);
          if (!st.ended) return { match: { id: info.event, end: st.end, left: st.left, name: (st.data?.basic?.game_name || "").slice(0, 16), from: "FB短網址" }, announced, desc: announcedDesc };
        } else if (info.isStore && !announced && fbAnnouncedDay !== today) {
          fbAnnouncedDay = today;
          try { writeFileSync(FB_STATE_FILE, JSON.stringify({ day: today })); } catch {}
          announced = true;
          announcedDesc = d;
        }
      }
    } catch {}
  }
  return { match: null, announced, desc: announcedDesc };
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
async function handleManualTarget(reason) {
  try {
    const txt = manualTargetText();
    if (!txt) return false;
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
    const non = inWin.filter(isNonCoin);
    const nCoin1 = inWin.filter((r) => r.package_name === "1 活動蝦幣").length;
    const n30 = inWin.filter((r) => r.package_name.includes("30")).length;
    const n50 = inWin.filter((r) => r.package_name.includes("50")).length;
    const n100 = inWin.filter((r) => r.package_name.includes("100")).length;
    const nCoin10 = inWin.filter((r) => isNonCoin(r) && r.prize_type === 2).length;
    const frac = total ? (non.length / total) * 100 : 0;
    const leftMin = left == null ? null : Math.round(left / 60);

    log(`feed lag=${Math.round(lag)}s${stale} | 近${CFG.window}s: ${total}中獎, 非1幣=${non.length}(${frac.toFixed(1)}%) [1幣${nCoin1}/30券${n30}/50券${n50}/100券${n100}/10幣${nCoin10}] | ${feedMode ? "feed模式" : "距結束≈" + leftMin + "分"}`);

    // burst 判斷
    const enough = total >= CFG.minWinners;
    const hitBurst = enough && non.length >= CFG.burst;
    const hitFrac = enough && frac >= CFG.frac * 100;
    let alerted = 0;
    if ((hitBurst || hitFrac) && now() - lastAlert >= CFG.cooldown) {
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
      win: CFG.window, total, non: non.length, frac: +frac.toFixed(1),
      n1: nCoin1, n30, n50, n100, n10: nCoin10,
      leftMin, alert: alerted,
    });

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
      // 1) 同一 event 是否滾到新的一天
      try {
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
  if (!CFG.barkKey && !CFG.once) {
    console.error("❌ 請設定 Bark key：BARK_KEY=xxx node monitor.mjs  （或 --bark-key xxx）\n   沒有 key 會無法推播。先跑 node monitor.mjs --test 驗證。");
    process.exit(1);
  }
  if (CFG.once) {
    log("🧪 --once 乾跑一輪（不推播、不循環）…");
    log("設定 window=" + CFG.window + "s burst=" + CFG.burst + " frac=" + CFG.frac + " minWinners=" + CFG.minWinners + " rows=" + CFG.rows);
    await oneCycle();
    process.exit(0);
  }
  // 手動餵入的目標優先（啟動時就有 manual-target.txt 就直接接管）
  try { if (await handleManualTarget("啟動時")) log(`🎯 啟動時由 manual-target.txt 接管目標`); } catch {}
  // 確保監視目標的 module 正確（target.json / --event / --url 可能換過 event）
  try {
    const mod = await resolveDrawModule(EVENT);
    if (!mod) throw new Error("無 Service.LUCKY_DRAW");
    if (mod !== DRAWMOD) { DRAWMOD = mod; saveTarget(); }
    log(`🎯 監視目標 event ${EVENT} / draw module ${DRAWMOD}` + (TARGET_OVERRIDDEN ? "（--event/--url 指定）" : ""));
  } catch (e) {
    log(`⚠ 目前目標 event ${EVENT} settings 讀取失敗：${e.message.slice(0, 60)}。暫時沿用 module ${DRAWMOD}。`);
  }
  const st = await getEventStatus().catch(() => null);
  const active = st !== null && !st.ended;
  log(`🎯 開始監視。活動剩餘: ${active ? Math.round(st.left / 60) + " 分" : "待機/未知"}（結束 ${active ? st.end : "-"}）`);
  log(`設定 window=${CFG.window}s burst=${CFG.burst} frac=${CFG.frac} minWinners=${CFG.minWinners} cooldown=${CFG.cooldown}s interval=${CFG.interval}s` + (CFG.keepAlive ? " keepAlive=on(24h)" : ""));
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