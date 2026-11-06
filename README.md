# Shopee 幸運蝦轉盤監控

> 監控 Shopee「幸運蝦轉盤」中獎榜，短時間內大量出現非 1 幣中獎時，用 Bark 推播通知。

---

## 一、快速開始

```bash
cd ~/shopee-sellerlck

# 本地：只收集資料 + 看圖表（不上推播）
node monitor.mjs --keep-alive --no-bark &
node dashboard.mjs &

# 本地：同時推播通知
BARK_KEY=你的金鑰 node monitor.mjs --keep-alive &
node dashboard.mjs &
```

打開 http://127.0.0.1:8787 看圖表。

---

## 二、貼轉盤連結就能切換

複製遊戲頁連結貼上即可（支援完整連結、短網址、module id）：

```bash
# 完整連結
node monitor.mjs --link "https://games.shopee.tw/sellerlck/event/xxxx" --keep-alive --no-bark

# 短網址
node monitor.mjs --link "https://s.shopee.tw/xxxx" --keep-alive --no-bark

# 直接指定 module（最穩）
node monitor.mjs --link "395391" --keep-alive --no-bark
```

也可以用 `manual-target.txt`（用完自動清空）：

```bash
echo "https://games.shopee.tw/sellerlck/event/xxxx" > manual-target.txt
# 或
echo "395391" > manual-target.txt
```

---

## 三、不貼連結時，如何自動找到轉盤

程式啟動後，若 `--keep-alive` 開啟，會進入 24h 待機模式。每次待機掃描（每 5 分鐘），依序執行以下策略：

### 策略 1：Module 掃描（最常用、最穩）

**原理**：Shopee 的中獎榜 API（`prize/list/module/{id}`）**不需要 event id**，只要 module id 即可取得資料。而 module id 是連續配發的，新場次的 module id 只會比舊的更大。

**做法**：
1. 從已知的 module id（例如 395391）開始，往上掃描（範圍 +10000，每輪 40 個，避免請求過密）
2. 對每個 module id，抓取 feed 最新 10 筆中獎記錄
3. 判斷新場次的兩個特徵：
   - **feed 正在滾**：最新一筆 `lucky_time` 距今 ≤ 120 秒
   - **本店獎項**：中獎列裡有「1 活動蝦幣」（本店的獎項特徵）
4. 兩個特徵都滿足 → 判定是本店的新場次，直接以 feed 模式接上

**游標持久化**：掃描進度（moduleCursor）存入 `target.json`，重啟時從上次位置繼續，不會重複掃描。

### 策略 2：同一 Event ID 滾到新一天

有些活動的 settings 會在同一個 event id 下更新 `begin_time` 到今天。程式讀 settings 發現未結束 → 自動接上。

### 策略 3：Feed 恢復滾動

event id 每天換的場合，舊 id 顯示結束但 feed 突然又在滾 → 判斷是新場次，轉 feed 模式。

---

## 四、整體運作流程

```
┌─────────────────────────────────────────────────────────┐
│  1. 啟動 → 讀 target.json → 取得上次的 module id        │
│  2. 抓取中獎榜 feed → 統計近 180 秒內的中獎者            │
│  3. 計算「非 1 幣」佔比 → 若 ≥90% 且 ≥20 人 → Bark 通知 │
│  4. 每 interval 秒重複 2-3                               │
│  5. 活動結束（feed 停止滾動 >30 分）→ 進入待機           │
│  6. 待機每 5 分鐘掃描新場次（module 掃描）→ 自動接上     │
└─────────────────────────────────────────────────────────┘
```

---

## 五、參數

| 參數 | 說明 | 預設 |
|---|---|---|
| `--interval` | 幾秒抓一次 | 30 |
| `--window` | 統計時間窗（秒） | 180 |
| `--min-winners` | 最少中獎人才判斷 | 20 |
| `--frac` | 非 1 幣佔比門檻 | 0.9 (90%) |
| `--cooldown` | 同一波冷卻（秒） | 600 |
| `--keep-alive` | 結束後待機，自動接新場次 | 關 |
| `--no-bark` | 不推播，只收資料 | 關 |
| `--chart` / `--no-chart` | 終端即時 ASCII 折線圖 | 開啟 |
| `--link` / `--add` | 貼連結或 module id 切換 | - |
| `--once` | 只跑一輪就結束 | 關 |
| `--test` | 測試 Bark | 關 |

---

## 六、檔案說明

| 檔案 | 說明 |
|---|---|
| `monitor.mjs` | 主程式 |
| `dashboard.mjs` | 圖表儀表板（http://127.0.0.1:8787） |
| `target.json` | 目前目標（自動更新） |
| `manual-target.txt` | 手動貼連結切換（用完清空） |
| `feed-data.jsonl` | 歷史統計資料 |
| `monitor.log` | 執行紀錄 |

---

## 七、注意事項

- feed 延遲 1～5 分鐘屬正常（多份後端副本）
- 僅監控中獎榜，無補獎功能
- 建議個人研究使用
- 活動結束後若有 `--keep-alive`，程式會自動待機並偵測新場次

## 八、免責聲明

- **僅供個人使用**：僅供個人學習、研究與技術交流用途，請勿用於商業、營利或任何非法用途。
- **非官方工具**：與 Shopee（蝦皮）無任何關聯、合作、授權或背書。
- **僅存取公開資料**：僅透過公開 API 抓取中獎榜資訊，不涉及自動抽獎、模擬點擊、登入或干擾遊戲機制。
- **使用風險自負**：使用者自行承擔使用風險，作者不對帳號限制、損失或爭議負責。
- **API 可能隨時變動**：Shopee 可能隨時調整 API，本專案不保證長期可用。
- **請遵守平台規範**：遵守 [Shopee 使用條款](https://help.shopee.tw/portal/4/article/77242)。
- **商標歸屬**：Shopee、蝦皮等名稱及相關商標屬其原權利人所有。