#!/bin/bash
# 推送 + 設 secret + 派發 workflow — 需 gh 已登入並有 workflow scope
set -e
cd "$(dirname "$0")"

echo "== 1/4 推送 =="
git push -u origin main

echo "== 2/4 BARK_KEY secret =="
gh secret set BARK_KEY --repo allenbear23/shopee-lucky-monitor --body "N6PPAzRoirsrf4j6k2Krv"

echo "== 3/4 MONITOR_FLAGS variable =="
gh variable set MONITOR_FLAGS --repo allenbear23/shopee-lucky-monitor --body "--interval 60"

echo "== 4/4 派發 run =="
gh workflow run "Shopee Lucky Monitor" --repo allenbear23/shopee-lucky-monitor
sleep 6
gh run list --repo allenbear23/shopee-lucky-monitor --limit 1