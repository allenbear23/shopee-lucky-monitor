#!/bin/bash
# ============================================================================
# 手動餵入下一個場次的連結／event id —— 不用重啟監視器，最慢 5 分鐘內接管
# ----------------------------------------------------------------------------
# 用法（擇一）：
#   bash feed-link.sh "https://s.shopee.tw/XXXXXX"          # 短網址（app 分享→複製連結）
#   bash feed-link.sh "https://games.shopee.tw/sellerlck/event/{id}"
#   bash feed-link.sh "{event_id}"
# ============================================================================
cd "$(dirname "$0")"
if [ -z "$1" ]; then
  echo "❌ 請帶連結：bash feed-link.sh \"<連結>\""
  exit 1
fi
printf '%s' "$1" > manual-target.txt
echo "✔ 已寫入 manual-target.txt：$1"
if pgrep -f "monitor.mjs" > /dev/null 2>&1; then
  echo "   監視器執行中 → 下一輪（≤10 秒內）就會接管。"
else
  echo "   ⚠ 監視器沒有在跑（檢查 launchd：bash start-local.sh）"
fi