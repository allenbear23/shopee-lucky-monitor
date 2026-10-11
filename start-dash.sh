#!/bin/bash
# 本機監視網頁：開啟（launchd 託管，登入/重開機自動起、掛掉自動重生）
set -e
PLIST=~/Library/LaunchAgents/com.shopee.sellerlck.dashboard.plist

launchctl bootout "gui/$(id -u)/com.shopee.sellerlck.dashboard" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✔ 網頁服務已啟動 → http://127.0.0.1:8787"
sleep 2
curl -s -o /dev/null -w "health: %{http_code}\n" http://127.0.0.1:8787/health || echo "✘ 尚未回應，看 cat dash.err"