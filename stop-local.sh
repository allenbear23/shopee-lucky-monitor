#!/bin/bash
# 本機 24/7 監視器：關閉（不刪 plist，只解除載入）
if launchctl print "gui/$(id -u)/com.shopee.sellerlck.monitor" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/com.shopee.sellerlck.monitor" 2>/dev/null || launchctl unload ~/Library/LaunchAgents/com.shopee.sellerlck.monitor.plist
  echo "✔ 已停止（下次開機不會自動起）"
else
  echo "本來就沒在跑"
fi
pkill -f "monitor.mjs --interval 60" 2>/dev/null && echo "✔ 殘留進程已清" || true