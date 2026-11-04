# next-bus-helper — 交通出門助手

靜態網頁（`index.html`＋`stops-data.json`＋`manual.html`＋PWA）＋一支 Cloudflare Worker。對象是看不懂路線圖的長輩。2026-11-04 建立。

- 本機預覽 port **8852**（`.claude/launch.json`）。
- GitHub Pages（Actions `pages.yml`，push master 自動部署）：<https://m255525.github.io/next-bus-helper/>；visitor-badge `m255525.nextbushelper`。
- Worker `next-bus-eta`：<https://next-bus-eta.content-workflow.workers.dev/eta>，原始碼 `worker/`，部署 `cd worker && npx wrangler deploy`（不會隨 git push 部署）。

## 設計原則（加功能前先想這條）
- 首頁只回答一件事：下一班幾分鐘到。不放路線圖、不放站序、不加分頁。
- 長輩只看，設定交給家人也可以：說「在哪上車、要去哪裡」，程式找直達車；用 LINE 連結傳給長輩，長輩只按「加入」。
- 查不到就說查不到，絕不顯示猜測的時間或假資料。
- 基準字 22px（26／30px）；按鈕至少約 3.1rem 高；語氣用「您」；手機返回鍵要能用（畫面切換走 `location.hash`）。
- 視覺＝電子站牌（黑底琥珀 LED＋公車藍），刻意和撕日曆系列（樂齡教練、家庭回憶錄）不同。

## 資料
- **只有台北市＋新北市**：兩市開放資料免金鑰。其他縣市要 TDX 會員金鑰（免金鑰每 IP 每天只有 20 次，撐不了即時更新），目前未做。
- `stops-data.json`（1.8MB，gzip 約 550KB，只有設定時才下載）：`tools/build_stops.py` 產生，`update-stops.yml` 每週一自動更新（只有日期不同不 commit）。格式見該檔開頭註解。
- 到站：`/eta?t=<台北StopID>&n=<新北StopID>`。台北讀 `GetEstimateTime.gz`（JSON），新北讀資料集 `07f7ccb3…` 的 CSV。Worker 用 `indexOf` 取值、不 parse 整包（免費方案 CPU 限制），只允許 `ALLOWED` 來源，不是開放代理。改埠號要同步改 `ALLOWED`。
- 秒數：>=0 預估；-1 尚未發車；-2 交管不停靠；-3 末班已過；-4 今日未營運。台北與新北的 StopID／RouteID 不重疊。

## 架構重點
- 站牌分群：同名且 600m 內併成一個 cluster（`IDX.cl`，兩側站牌同群，方向由目的地決定）。
- `sameSpot()`：臺北車站(忠孝)／(重慶) 這類括號站位，**上車分開選、下車視為同一地方**。
- `nearSpots()`：對向站牌常叫別的名字（例如重慶幹線往天母不停「臺北車站」，要到中華路北站），所以回程、找不到同名站時放寬 500m；這一站沒有直達時列出附近有直達的上車站。
- `judge(trip)`：選「走得到還趕得上」的最快一班，全部趕不上時顯示最快一班＋「不用跑」。測試掛鉤 `window._nbh`（`setEtas` 可注入秒數）。
- 🔔 時間到叫我：網頁不能背景執行，畫面要開著（Wake Lock 防休眠）。
- 分享連結 `?openExternalBrowser=1#add=<base64url>`：`openExternalBrowser` 讓 LINE 改用手機瀏覽器開，資料才會留在瀏覽器；內容在 `parseAdd()` 驗證。
- 儲存鍵 `nbh.trips`、`nbh.settings`、`nbh.fold`、`nbh.warnSeen`、`nbh.marquee`。
- 標準配備：跑馬燈（不可關）、⚙ 常用設定（收合式＋關於本工具）、首訪警語、manual.html#creator 完整版、PWA、訪客計數器。
- `manual.html` 由 `tools/build_manual.py` 組出，改手冊要改 `tools/manual_body.html` 再重跑。
- 改 `index.html` 上線時要升 `service-worker.js` 的 `CACHE_NAME`。
