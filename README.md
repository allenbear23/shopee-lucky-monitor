# Shopee 幸運蝦轉盤監控

自動監控 Shopee「幸運蝦轉盤」（`shopee_choice_hl`）中獎榜，當短時間內出現大量非 1 活動蝦幣中獎時透過 [Bark](https://github.com/Finb/Bark) 推播通知，並提供本地即時折線圖儀表板。

## 功能

- **即時中獎監控** – 直接抓取 Shopee gameplatform 的中獎榜 feed（`prize/list/module`）
- **爆量偵測** – 統計近 `180` 秒內中獎者，當「非 1 活動蝦幣」佔比 ≥ `90%` 且中獎人數 ≥ `20` 時才會發送 Bark 通知
- **獨立用戶統計** – 以用戶去重計算獨立中獎人數
- **自動換場次** – 偵測新模組（module）上線，自動切換監控目標
- **本地儀表板** – 即時折線圖、各獎項佔比、feed 延遲（`http://127.0.0.1:8787`）
- **雲端 24/7** – GitHub Actions 每 6 小時接續執行，concurrency 防止重複推播
- **`--no-bark` 模式** – 僅收集資料不上推播，適合本地看圖表

## 快速開始

### 本地執行

```bash
# 僅收集資料 + 圖表
TZ=Asia/Taipei node monitor.mjs --interval 10 --keep-alive --no-bark &
node dashboard.mjs --port 8787 --host 127.0.0.1

# 同時推播通知
TZ=Asia/Taipei BARK_KEY=your_key node monitor.mjs --interval 10 --keep-alive &
node dashboard.mjs --port 8787 --host 127.0.0.1
```

瀏覽 [http://127.0.0.1:8787](http://127.0.0.1:8787) 查看儀表板。

### 設定目標

編輯 `target.json`（module-only 模式）：

```json
{"event":"","drawmod":391384,"savedAt":1767200000}
```

### 環境變數

| 變數 | 說明 |
|---|---|
| `BARK_KEY` | Bark 推播金鑰 |
| `TZ` | 建議設為 `Asia/Taipei` |

## 檔案說明

| 檔案 | 說明 |
|---|---|
| `monitor.mjs` | 主監控程式 |
| `dashboard.mjs` | 本地儀表板 |
| `target.json` | 本機監控目標 |
| `cloud-target.json` | 雲端監控目標 |
| `feed-data.jsonl` | 本機歷史資料 |
| `.github/workflows/shopee-monitor.yml` | GitHub Actions 設定 |

## 注意事項

- feed 可能有 1～5 分鐘延遲屬正常現象
- 僅監控中獎榜，並無公開補獎 API
- 建議僅供個人研究觀察使用
