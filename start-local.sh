#!/bin/bash
# 本機 24/7 監視器：開啟（launchd 託管，登入/重開機自動起、掛掉自動重生）
# 注意：launchd 會快取載入時參數 → 一律 bootout+bootstrap 確保新參數生效
set -e
PLIST=~/Library/LaunchAgents/com.shopee.sellerlck.monitor.plist

launchctl bootout "gui/$(id -u)/com.shopee.sellerlck.monitor" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✔ 已重載並啟動"
sleep 2
pgrep -f "monitor.mjs" >/dev/null && echo "✔ 進程存活：$(pgrep -f 'monitor.mjs')" || echo "✘ 進程未存活，看 cat monitor.err"