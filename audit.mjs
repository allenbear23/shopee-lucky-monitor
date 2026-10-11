// Shopee 賣場遊戲「幸運蝦轉盤」獎池稽核
// 目標：https://games.shopee.tw/sellerlck/event/1851933cb3be1af7
// 用法：node audit.mjs [--watch N]   (N = 秒數間隔；預設只抓一次)
// 所有 endpoint 皆公開，不需登入。AA 欄是誠實度分級：
//   確定   = 直接從資料讀出
//   推論   = 由確定資料推導（有寫前提）
//   查不出 = endpoint 不提供

const EVENT = "1851933cb3be1af7";          // event/ 後的 hash
const APPID = "9bv5119Po61HKw0Tdn";        // 從前端 bundle main.667179d6.js 解出的 appid
const DRAWMOD = 391057;                    // Service.LUCKY_DRAW module_id
const CHANCEMOD = 60191;                   // Service.CHANCE module_id
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const H = { "User-Agent": UA, Referer: `https://games.shopee.tw/sellerlck/event/${EVENT}` };

async function getJson(url) {
  const r = await fetch(url, { headers: H });
  const txt = await r.text();
  if (!r.ok && !txt.startsWith("{")) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 120)}`);
  return JSON.parse(txt);
}

const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;

async function winners(offset, limit) {
  const d = await getJson(
    `https://games.shopee.tw/gameplatform/api/v2/goluckydraw/prize/list/module/${DRAWMOD}?appid=${APPID}&offset=${offset}&limit=${limit}`
  );
  return d.data || [];
}

async function collectWinners(max = 1000) {
  const all = [];
  const seen = new Set();
  for (let off = 0; off < max; off += 100) {
    const batch = await winners(off, 100); // feed 上限 = 最新 1000 筆（約 17 分鐘）
    if (!batch.length) break;
    let added = 0;
    for (const x of batch) {
      const k = `${x.user_id}:${x.lucky_time}:${x.package_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(x);
      added++;
    }
    if (batch.length < 100 || !added) break;
  }
  return all;
}

async function main() {
  const settings = (await getJson(
    `https://games.shopee.tw/gameplatform/api/v1/game/settings/event/${EVENT}?appid=${APPID}`
  )).data;
  const shop = (await getJson(`https://games.shopee.tw/sellerlck/api/v1/get/shop/${EVENT}`)).data;
  const prizes = (await getJson(
    `https://games.shopee.tw/gameplatform/api/v2/goluckydraw/prize/config/module/${DRAWMOD}?appid=${APPID}`
  )).data;
  const tplListing = (await getJson(
    `https://games.shopee.tw/gameplatform/api/v2/asset/list?appid=${APPID}&module_ids=892954`
  )).data[0];
  const tpl = await (
    await fetch(`https://deo.shopeemobile.com/shopee/mkt/games/gameplatform/assets/${tplListing.cdn}`, { headers: H })
  ).json();

  const w = await collectWinners();
  w.sort((a, b) => b.lucky_time - a.lucky_time);
  const tNow = Math.floor(Date.now() / 1000);
  const tEnd = settings.basic.end_time;
  const span = w.length ? Math.max(1, w[0].lucky_time - w[w.length - 1].lucky_time) : 1;
  const mix = {};
  for (const x of w) mix[x.package_name] = (mix[x.package_name] || 0) + 1;

  console.log(`===== 活動：${settings.basic.game_name}`);
  console.log(`店家：${shop.shop_name}  shop_id=${shop.shop_id}  ${shop.shop_link}`);
  console.log(
    `期間(臺北)：${new Date(settings.basic.begin_time * 1000).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })} → ${
      new Date(tEnd * 1000).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })
    }  剩餘 ${((tEnd - tNow) / 3600).toFixed(1)} 小時  [確定]`
  );
  console.log("\n-- 機會規則 (Template) --");
  console.log(tpl.chances);

  console.log("\n-- 獎項表 (prize/config，無機率欄位、無 remain 欄位) --");
  for (const p of prizes) {
    const pi = p.prize_info;
    const kind =
      p.prize_type === 2
        ? `${pi.coin.quantity} 活動蝦幣 (=${pi.coin.name})`
        : p.prize_type === 1
        ? `${pi.voucher.name} (voucher_id ${pi.voucher.voucher_id})`
        : "摃龜/無獎";
    console.log(`  prize_id=${p.prize_id}  ${kind}`);
  }

  console.log(`\n-- 近期中獎 feed（最新 ${w.length} 筆，跨 ${(span / 60).toFixed(1)} 分鐘）[確定] --`);
  console.log(`  中獎速率 ≈ ${(w.length / span).toFixed(2)} 筆/秒 (${((w.length / span) * 60).toFixed(0)} 筆/分)`);
  for (const [k, v] of Object.entries(mix)) console.log(`  ${k.padEnd(24)} ${String(v).padStart(5)}  ${pct(v, w.length)}`);

  console.log("\n-- 誠實分級 --");
  console.log("  確定   ：活動起訖、店家、獎項表、上述 winner feed 比率");
  console.log("  推論   ：獎項機率 ≈ feed 比率（前提：feed 是純隨機獲勝紀錄，未證實）");
  console.log("  查不出 ：摃龜率、本日總抽數、獎池剩餘 —— 公開 endpoint 不提供，chance/query 需登入");
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});