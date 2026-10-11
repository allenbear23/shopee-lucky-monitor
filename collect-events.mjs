#!/usr/bin/env node
// ============================================================================
// Shopee 全平台轉盤「公開連結收集器」
// ----------------------------------------------------------------------------
// 目標 : 收集網路上公開分享的 games.shopee.tw/sellerlck/event/{hex} 連結，
//       撈活動名稱/時間、分類「進行中/未開/已結束」、對「新偵測到且進行中」
//       的轉盤用 Bark 通知（同一場只通知一次，靠 begin_time 當場次 key）。
//
// 原理 : 平台沒有「列出所有活動」的 API（已實測 404），event id 是稀疏
//       uint64、盲掃不可行。唯一無登入管道 = 公開搜尋引擎索引到的分享連結。
//       所以這支是「海撈已知在跑的」，不是「枚舉所有」。
//
// 用法 :
//   BARK_KEY=xxx node collect-events.mjs                    # 跑一輪就結束
//   node collect-events.mjs --once --ids 1851933cb3be1af7   # 指定既有場次一起查
//   node collect-events.mjs --interval 3600 --state ./db.json  # 每小時循環
// ============================================================================

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const APPID = "9bv5119Po61HKw0Tdn";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const QUERIES = [
  "games.shopee.tw sellerlck event",
  "site:games.shopee.tw sellerlck",
  "site:games.shopee.tw event",
  "games.shopee.tw/sellerlck/event",
];

const DEFAULT = {
  state: "events-db.json",
  interval: 0,       // 循環間隔(秒)，0 = 單次
  maxResults: 20,    // 每組關鍵字取前幾個結果
  searchDelay: 1200, // 每組關鍵字間隔(ms)
  fetchDelay: 400,   // 每筆 settings 請求間隔(ms)
  ttl: 600,
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return def;
}
const CFG = {
  ...DEFAULT,
  state: arg("state", DEFAULT.state),
  interval: +arg("interval", DEFAULT.interval),
  maxResults: +arg("max-results", DEFAULT.maxResults),
  searchDelay: +arg("search-delay", DEFAULT.searchDelay),
  fetchDelay: +arg("fetch-delay", DEFAULT.fetchDelay),
  ids: arg("ids", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  barkKey: arg("bark-key", process.env.BARK_KEY || ""),
  ttl: +arg("ttl", DEFAULT.ttl),
};

const now = () => Date.now() / 1000;
const fmt = (t) => new Date(t * 1000).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
const settingsUrl = (id) =>
  `https://games.shopee.tw/gameplatform/api/v1/game/settings/event/${id}?appid=${APPID}`;

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString("zh-TW", { hour12: false })}] ${msg}`);
}

let state = { ids: {} };
function loadState(p) {
  if (existsSync(p)) {
    try { state = JSON.parse(readFileSync(p, "utf8")); } catch { state = { ids: {} }; }
  }
  if (!state.ids) state.ids = {};
}
function saveState(p) {
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

// ----------------------------------------------------------------------------
// 來源 1：DuckDuckGo HTML 搜尋（唯一實作；之後可擴充 --sources）
async function ddgSearch(query, max) {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!r.ok) throw new Error(`DDG HTTP ${r.status}`);
  const html = await r.text();
  const hrefs = new Set();
  for (const m of html.matchAll(/uddg=([^"&]+)/g)) hrefs.add(decodeURIComponent(m[1]));
  for (const m of html.matchAll(/class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/g)) hrefs.add(m[1]);
  return [...hrefs].slice(0, max);
}

function extractEventIds(url) {
  const ids = new Set();
  for (const m of url.matchAll(/sellerlck\/event\/([0-9a-f]{8,})/gi)) ids.add(m[1].toLowerCase());
  for (const m of url.matchAll(/universal-link\/sellerlck\/event\/([0-9a-f]{8,})/gi)) ids.add(m[1].toLowerCase());
  return ids;
}

// ----------------------------------------------------------------------------
// 撈活動資訊
async function fetchEvent(id) {
  const r = await fetch(settingsUrl(id), {
    headers: { "User-Agent": UA, Referer: `https://games.shopee.tw/sellerlck/event/${id}` },
  });
  if (r.status !== 200) return null; // 400 = 無效 id
  let j;
  try { j = await r.json(); } catch { return null; }
  const b = j?.data?.basic;
  if (!b || !b.end_time) return null;
  return {
    id,
    name: b.game_name || "",
    begin: b.begin_time,
    end: b.end_time,
    slot: b.slot_name || "",
  };
}

const statusOf = (ev) => (ev.begin > now() ? "upcoming" : ev.end < now() ? "ended" : "active");

async function sendBark(title, body, group = "shopee-events") {
  if (!CFG.barkKey) return false;
  const url = `${"https://api.day.app"}/${encodeURIComponent(CFG.barkKey)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${group}&isArchive=1&ttl=${CFG.ttl}`;
  try {
    const r = await fetch(url);
    const t = await r.text();
    log(`📲 Bark 已送出 (${r.status}) ${t.slice(0, 80)}`);
    return r.ok;
  } catch (e) { log(`❌ Bark 失敗 ${e.message}`); return false; }
}

// ----------------------------------------------------------------------------
async function collectOnce() {
  const srcIds = new Set();
  for (const q of QUERIES) {
    try {
      const links = await ddgSearch(q, CFG.maxResults);
      let got = 0;
      for (const l of links) for (const id of extractEventIds(l)) { srcIds.add(id); got++; }
      log(`🔎 搜尋「${q}」→ ${links.length} 結果 / ${got} 個 event id`);
    } catch (e) { log(`⚠ 搜尋失敗「${q}」: ${e.message.slice(0, 80)}`); }
    await sleep(CFG.searchDelay);
  }

  const ids = new Set([...Object.keys(state.ids), ...srcIds, ...CFG.ids]);
  log(`📥 已知 ${Object.keys(state.ids).length} + 來源新增 ${srcIds.size} → 共檢查 ${ids.size} 個`);

  const active = [];
  let first = true;
  for (const id of ids) {
    if (!first) await sleep(CFG.fetchDelay);
    first = false;
    const ev = await fetchEvent(id).catch(() => null);
    const rec = state.ids[id] || { firstSeen: now() };
    rec.lastSeen = now();
    if (!ev) {
      rec.valid = false;
      state.ids[id] = rec;
      continue;
    }
    rec.valid = true;
    rec.name = ev.name || rec.name;
    rec.begin = ev.begin;
    rec.end = ev.end;
    rec.foundVia = rec.foundVia || (srcIds.has(id) ? "search" : "known");
    if (!rec.alerted) rec.alerted = [];
    state.ids[id] = rec;

    const st = statusOf(ev);
    if (st === "active") {
      active.push(ev);
      const key = `${id}@${ev.begin}`;
      if (!rec.alerted.includes(ev.begin)) {
        rec.alerted.push(ev.begin);
        const left = Math.round((ev.end - now()) / 60);
        const title = `🎰 新轉盤上線：${(ev.name || id).slice(0, 18)}`;
        const body = `開始 ${fmt(ev.begin)} → 結束 ${fmt(ev.end)}（剩 ${left} 分）\nhttps://games.shopee.tw/sellerlck/event/${id}`;
        await sendBark(title, body);
      }
    }
  }

  // 輸出
  active.sort((a, b) => a.end - b.end);
  const table = active.map((ev) => {
    const rec = state.ids[ev.id];
    const left = Math.round((ev.end - now()) / 60);
    return `🟢 ${ev.name || ev.id} | 結束 ${fmt(ev.end)}（剩 ${left} 分）| ${ev.id}` + (rec.foundVia === "search" ? " [搜尋發現]" : "");
  });
  log(`✅ 進行中轉盤 ${active.length} 筆：\n` + (table.join("\n") || "  （無）"));

  writeFileSync("events-active.json", JSON.stringify(active, null, 2));
  saveState(CFG.state);
  return active;
}

// ----------------------------------------------------------------------------
async function main() {
  loadState(CFG.state);
  log(`🎯 收集器啟動。state=${CFG.state} 已知 ${Object.keys(state.ids).length} 筆` + (CFG.barkKey ? "" : "（未設 BARK_KEY → 不推播）"));
  do {
    await collectOnce();
    if (!CFG.interval) break;
    log(`💤 ${CFG.interval}s 後再掃…`);
    await sleep(CFG.interval * 1000);
    loadState(CFG.state);
  } while (true);
}

main().catch((e) => { console.error("❌ 啟動失敗", e); process.exit(1); });