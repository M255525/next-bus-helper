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
- `stops-data.json`（1.8MB，gzip 約 550KB，只有設定時才下載）：`tools/build_stops.py` 產生，`update-stops.yml` 每週一自動更新（只有日期不同不 commit）。格式見該檔開頭註解。新北 API 偶爾回不完整，`build_stops.py` 資料量檢查會拒絕覆寫，重跑即可。
- 到站：`/eta?t=<台北StopID>&n=<新北StopID>`。台北讀 `GetEstimateTime.gz`（JSON），新北讀資料集 `07f7ccb3…` 的 CSV。Worker 用 `indexOf` 取值、不 parse 整包（免費方案 CPU 限制），不是開放代理。**白名單 `ALLOWED` 在伺服器端強制**：Origin 不符（含沒帶 Origin）一律 403、不抓上游，所以 curl 測試要加 `-H "Origin: https://m255525.github.io"`。改埠號或換網域要同步改 `ALLOWED` 並重新 deploy，否則畫面會一直「暫時查不到」。Origin 可被非瀏覽器偽造，這層只擋別的網站盜用與隨手呼叫。
- 秒數：>=0 預估；-1 尚未發車；-2 交管不停靠；-3 末班已過；-4 今日未營運。台北與新北的 StopID／RouteID 不重疊。

## 架構重點
- 站牌分群：同名且 600m 內併成一個 cluster（`IDX.cl`，兩側站牌同群，方向由目的地決定）。
- `sameSpot()`：臺北車站(忠孝)／(重慶) 這類括號站位，**上車分開選、下車視為同一地方**。
- `nearSpots()`：對向站牌常叫別的名字（例如重慶幹線往天母不停「臺北車站」，要到中華路北站），所以回程、找不到同名站時放寬 500m；這一站沒有直達時列出附近有直達的上車站。
- `judge(trip)`：選「走得到還趕得上」的最快一班，全部趕不上時顯示最快一班＋「不用跑」。測試掛鉤 `window._nbh`（`setEtas` 可注入秒數）。
- 更新頻率 `nextDelay()`（省 Worker 呼叫次數）：離該出門 15 分鐘內、等提醒、查詢失敗＝30 秒；15～30 分＝60 秒；30 分以上＝2 分；還沒發車＝60 秒；今天沒車＝5 分。多趟取最短。`keep` 隨間隔放寬，否則間隔超過 90 秒會誤顯示「暫時查不到」。Worker 內的快取不會減少計費次數，只有前端少呼叫才算。
- 自動更新時段（`#sched=<tripId>`，`vSched()`）：每一趟自己的 `t.week`（索引＝`getDay()`，`{on,a,b,a2?,b2?,x?}`，沒有＝全天），隨分享連結傳送。`a2/b2`＝第二段時間，`x`＝當天不看的路線（`busK`＝`路線|往哪`，存排除清單所以之後新增的車預設會看，至少留一路）。**要查、要判斷的車一律走 `busesNow(t)`，不要直接用 `t.b`**；跨夜那段沿用開始那天的路線。**時段外完全不呼叫 Worker（使用者要求）**：`poll()` 只查 `live()` 的趟次，打開畫面、再看一次也一樣；卡片顯示「現在不更新」＋`nextWin()`；🔔 時段外不能開，等到一半時段結束由 `endAlarm()` 關閉並語音告知。全天的趟次不受影響。新鮮度看 `seenAt(t)`（`tripAt`＋`tripKey`，要看的車換了就算還沒查過），不是全域。時段開始時由 5 秒 `setInterval` 比對 `liveKey` 接回。
- 班次對照：`stops-data.json` 的 `r[5]`（首末班＋班距，平日／假日，依方向）。**首末班是起站時間**，判斷「這段時間有車」放寬 90 分鐘，「依班次帶入」末班＋1 小時。不用 `GetTimeTable`：不分去返程且多數路線不完整（617 只列晚上 3 班）；新北沒有時刻表。國定假日資料沒有，週六日算假日。
- 🔔 時間到叫我：網頁不能背景執行，畫面要開著（Wake Lock 防休眠）。
- 分享連結 `?openExternalBrowser=1#add=<base64url>`：`openExternalBrowser` 讓 LINE 改用手機瀏覽器開，資料才會留在瀏覽器；內容在 `parseAdd()` 驗證。
- 儲存鍵 `nbh.trips`、`nbh.settings`、`nbh.fold`、`nbh.warnSeen`、`nbh.marquee`。
- 標準配備：跑馬燈（不可關）、⚙ 常用設定（收合式＋關於本工具）、首訪警語、manual.html#creator 完整版、PWA、訪客計數器。
- `manual.html` 由 `tools/build_manual.py` 組出，改手冊要改 `tools/manual_body.html` 再重跑。
- 改 `index.html` 上線時要升 `service-worker.js` 的 `CACHE_NAME`。
