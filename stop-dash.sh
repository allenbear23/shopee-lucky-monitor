#!/bin/bash
# 本機監視網頁：關閉（不刪 plist，只解除載入）
if launchctl print "gui/$(id -u)/com.shopee.sellerlck.dashboard" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/com.shopee.sellerlck.dashboard" 2>/dev/null || launchctl unload ~/Library/LaunchAgents/com.shopee.sellerlck.dashboard.plist
  echo "✔ 網頁已停止（下次開機不會自動起）"
else
  echo "本來就沒在跑"
fi