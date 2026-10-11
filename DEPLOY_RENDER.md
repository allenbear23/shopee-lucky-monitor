# Render 部署步驟（Background Worker 方案）

## 為什麼選 worker
- Free Web Service 會因「15 分鐘無進站流量」休眠 → 出站-only 的監視器會被凍結。
- Background Worker 無此問題；Starter 按秒計費，跑一場 2 小時活動約 **$0.03**。

## 步驟
1. 把 `/Users/allen/shopee-sellerlck` 推到一個 GitHub repo（monitor.mjs、Dockerfile、render.yaml）。
2. Render Dashboard → **New → Blueprint** → 選該 repo。
3. 部署完成後，到該 service 的 **Environment** 頁填入：
   - `BARK_KEY` = 你的 Bark key
   - `MONITOR_FLAGS` = `--interval 60`（事件不同可改；`--burst`/`--frac`/`--window` 可調）
4. 到 **Logs** 看每一輪輸出；測試推播：在 Terminal 或 dashboard 的 shell 不可用的話，拉一個暫存 web service 跑
   `node monitor.mjs --test` 或直接改一版再部署（見下方 Cron 方案備用）。

## 停止計費
- 活動結束後（監視器會自動通知「活動已結束」並退出）到 dashboard **Suspend / Delete** 該 service。

## 若想用 Cron Job（每分鐘檢查一次、每次都是新進程）
- 優點：幾乎 $0 月費外（$1/月最低）。
- 但「10 分鐘冷卻不重複通知」是記憶體狀態，跨進程會失效 → 爆量時每分鐘都會推。
- render.yaml 要改 `type: cron`、排程 `* * * * *`、指令 `node monitor.mjs --once`。
- 不建議，除非你接受可能的重複通知。

## 安全提醒
- Bark key 只放 environment variable，**不要 commit**。
- 對蝦皮的請求維持每 60 秒一次，避免觸發活動條款的「惡意程式干擾」認定（規則第 1 條）。