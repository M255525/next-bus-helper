/**
 * 交通出門助手——登入序號驗證後端（比照內容工作流工作室的登入閘門）。
 * 綁定在試算表「樂齡工具」上，固定只查分頁「交通出門助手」（同一份試算表之後可能放其他樂齡工具的分頁）。
 * 部署為 Web App 後，把網址填進 index.html 的 LICENSE_CHECK_URL。
 * 用表頭文字比對「序號／開始日期／結束日期」欄，其他欄位（任務、負責人…）不動。
 *
 * 使用人數限制：表頭有「人數限制」欄且該列有填數字，就限制「同一時間最多幾個瀏覽器在線」；
 * 名額記在「已登入裝置」欄（clientId:時間戳|...），逾時 SESSION_TIMEOUT_MS 自動釋出；
 * 前端每 20 分鐘背景重驗續命，關閉分頁時用 sendBeacon 送 release:true 盡力立即釋出。
 * 人數限制只在「登入當下」把關：已經登入的瀏覽器背景重驗時會帶 renew:true，即使名額已滿（例如它的名額逾時被別人補上）也不會被踢出。
 * 若表頭有「目前登入人數」欄，每次驗證／釋出都會把目前在線人數寫進去，方便在試算表上直接看。
 */

const VALID_AMOUNT = 12; // 使用期限：12 個月
const COL_SERIAL = "序號";
const COL_START = "開始日期";
const COL_END = "結束日期";
const COL_LIMIT = "人數限制"; // 選填欄，留空＝不限制人數
const COL_DEVICES = "已登入裝置";
const COL_ACTIVE = "目前登入人數"; // 選填欄，有這欄才會寫入目前在線人數 // 選填欄，記錄「目前在線」名額（clientId:時間戳），找不到會自動補上表頭
const DEVICE_SEP = "|";
const SHEET_NAME = "交通出門助手";
// 名額多久沒有任何動靜（沒有背景重驗、也沒收到 release）就視為離線、自動釋出——
// 略大於前端每 20 分鐘一次的背景重驗間隔，留一點緩衝給網路延遲/瀏覽器背景分頁計時器被節流的情況。
const SESSION_TIMEOUT_MS = 40 * 60 * 1000; // 40 分鐘

function doPost(e) {
  let result;
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const serial = String(payload.serial || "").trim();
    const sheetName = String(payload.sheet || "").trim(); // 選填：指定要查哪個分頁（例如登入序號查「前門」），留空維持既有行為
    const clientId = String(payload.clientId || "").trim(); // 選填：這個瀏覽器的識別碼，用於人數限制的重複登入判斷
    const renew = payload.renew === true; // 已登入者的背景重驗：只續命、不受人數上限阻擋

    if (payload.release) {
      // 關閉分頁時的「盡力釋出名額」通知（navigator.sendBeacon 送出，不等回應內容）
      releaseSession_(serial, sheetName, clientId);
      result = { ok: true };
    } else {
      result = serial ? checkOrActivate(serial, sheetName, clientId, renew) : { valid: false, reason: "missing_serial" };
    }
  } catch (err) {
    result = { valid: false, reason: "server_error", message: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// 方便部署後用瀏覽器直接開網址測試是否部署成功
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    message: "授權伺服器運作中。請用 POST 傳送 JSON body，例如 {\"serial\":\"your-serial-here\"}"
  })).setMimeType(ContentService.MimeType.JSON);
}

function getLicenseSheet_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 固定分頁：找不到就回 null（呼叫端回 server_error），絕不退回第一個分頁——那是別的工具的序號表
  return ss.getSheetByName(sheetName || SHEET_NAME) || null;
}

// 把「已登入裝置」欄的字串解析成 [{id, ts}, ...]；舊格式（2026-09-23 當天稍早的版本，
// 只存 clientId、沒有時間戳）一律視為 ts:0（絕對逾時），下次讀取就會被自動清掉，不需要另外寫遷移邏輯。
function parseDeviceEntries_(raw) {
  if (!raw) return [];
  return String(raw).split(DEVICE_SEP).filter(function (s) { return s; }).map(function (s) {
    const idx = s.lastIndexOf(":");
    if (idx < 0) return { id: s, ts: 0 };
    const ts = parseInt(s.slice(idx + 1), 10);
    return { id: s.slice(0, idx), ts: isNaN(ts) ? 0 : ts };
  });
}

function writeActiveCount_(sheet, header, sheetRow, count) {
  const colActive = header.indexOf(COL_ACTIVE);
  if (colActive >= 0) sheet.getRange(sheetRow, colActive + 1).setValue(count);
}

function serializeDeviceEntries_(entries) {
  return entries.map(function (d) { return d.id + ":" + d.ts; }).join(DEVICE_SEP);
}

// 關閉分頁時的「盡力釋出名額」：找到這一列，把這個 clientId 從目前在線清單裡拿掉。
// 找不到序號／欄位、或這組序號根本沒套用人數限制，都直接安靜地不做任何事——
// 這是背景通知，不需要、也不應該讓使用者看到任何錯誤。
function releaseSession_(serial, sheetName, clientId) {
  if (!serial || !clientId) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getLicenseSheet_(sheetName);
    if (!sheet) return;
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return;
    const header = values[0];
    const colSerial = header.indexOf(COL_SERIAL);
    const colDevices = header.indexOf(COL_DEVICES);
    if (colSerial < 0 || colDevices < 0) return;

    let rowIdx = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][colSerial]).trim() === serial) { rowIdx = i; break; }
    }
    if (rowIdx === -1) return;

    const sheetRow = rowIdx + 1;
    const entries = parseDeviceEntries_(values[rowIdx][colDevices]).filter(function (d) { return d.id !== clientId; });
    sheet.getRange(sheetRow, colDevices + 1).setValue(serializeDeviceEntries_(entries));
    writeActiveCount_(sheet, header, sheetRow, entries.length);
  } finally {
    lock.releaseLock();
  }
}

function checkOrActivate(serial, sheetName, clientId, renew) {
  // LockService 避免多人同時第一次驗證同一組序號時，開卡時間被寫兩次、算出不同的到期日；
  // 同一把鎖也保護人數限制的「讀取目前在線名單→判斷→寫回」這段不會被同時進來的請求互相蓋掉。
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getLicenseSheet_(sheetName);
    if (!sheet) {
      return { valid: false, reason: "server_error", message: "找不到分頁「" + (sheetName || SHEET_NAME) + "」，請確認試算表裡已建立這個分頁" };
    }
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return { valid: false, reason: "serial_not_found" };

    const header = values[0];
    const colSerial = header.indexOf(COL_SERIAL);
    const colStart = header.indexOf(COL_START);
    const colEnd = header.indexOf(COL_END);
    if (colSerial < 0 || colStart < 0 || colEnd < 0) {
      return { valid: false, reason: "server_error", message: "表頭找不到「" + COL_SERIAL + "」「" + COL_START + "」「" + COL_END + "」欄位" };
    }

    let rowIdx = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][colSerial]).trim() === serial) { rowIdx = i; break; }
    }
    if (rowIdx === -1) return { valid: false, reason: "serial_not_found" };

    const sheetRow = rowIdx + 1; // 轉成 1-indexed 的實際列號
    let startVal = values[rowIdx][colStart];
    let endVal = values[rowIdx][colEnd];
    const now = new Date();

    // 第一次有人驗證這組序號：開始計時
    if (!startVal) {
      startVal = now;
      sheet.getRange(sheetRow, colStart + 1).setValue(startVal);
    }
    // 若結束日期還沒算過（或開始日期是這次才補的），依開始日期 + VALID_AMOUNT（月）算出
    if (!endVal) {
      endVal = new Date(startVal);
      endVal.setMonth(endVal.getMonth() + VALID_AMOUNT);
      sheet.getRange(sheetRow, colEnd + 1).setValue(endVal);
    }

    const endDate = new Date(endVal);
    endDate.setHours(23, 59, 59, 999); // 結束日當天結束前都算有效
    let valid = now.getTime() <= endDate.getTime();
    const baseResult = {
      reason: valid ? "ok" : "expired",
      activatedAt: new Date(startVal).toISOString(),
      expiresAt: new Date(endVal).toISOString()
    };

    // 人數限制：只有這個表頭真的有「人數限制」欄、且這一列有填數字時才套用，其餘序號完全不受影響
    const colLimit = header.indexOf(COL_LIMIT);
    const limitRaw = colLimit >= 0 ? values[rowIdx][colLimit] : "";
    const limitNum = parseInt(limitRaw, 10);
    if (colLimit >= 0 && limitRaw !== "" && !isNaN(limitNum) && limitNum > 0) {
      let colDevices = header.indexOf(COL_DEVICES);
      if (colDevices < 0) {
        // 表頭沒有「已登入裝置」欄，自動在最後補一欄，不需要使用者手動先建立
        colDevices = header.length;
        sheet.getRange(1, colDevices + 1).setValue(COL_DEVICES);
      }
      const devicesRaw = sheet.getRange(sheetRow, colDevices + 1).getValue();
      const cutoff = now.getTime() - SESSION_TIMEOUT_MS;
      // 只保留時間戳還在時效內的名額＝「目前還算在線」；逾時的直接濾掉，等於自動釋出名額
      let activeEntries = parseDeviceEntries_(devicesRaw).filter(function (d) { return d.ts >= cutoff; });

      if (valid) {
        const existingIdx = clientId ? activeEntries.findIndex(function (d) { return d.id === clientId; }) : -1;
        if (existingIdx >= 0) {
          // 這個瀏覽器本來就在名額內，只是延續它的在線時間，不會多佔一個名額
          activeEntries[existingIdx].ts = now.getTime();
        } else if (activeEntries.length >= limitNum && !renew) {
          // 已達上限：仍然把「濾掉逾時名額後」的結果寫回去（可能比原本存的少幾筆），但不把這個新裝置加進去
          sheet.getRange(sheetRow, colDevices + 1).setValue(serializeDeviceEntries_(activeEntries));
          writeActiveCount_(sheet, header, sheetRow, activeEntries.length);
          return Object.assign({}, baseResult, {
            valid: false,
            reason: "headcount_exceeded",
            message: "此序號目前已達使用人數上限（" + limitNum + " 人）。若有人離線會自動釋出名額，請稍後再試，或聯繫工具提供者",
            headcountLimit: limitNum,
            headcountUsed: activeEntries.length,
            headcountRemaining: 0
          });
        } else if (clientId) {
          // 新登入（名額未滿），或已登入者重驗時名額已逾時被清掉——後者即使超過上限也補回去，人數限制只在登入當下把關
          activeEntries.push({ id: clientId, ts: now.getTime() });
        }
        sheet.getRange(sheetRow, colDevices + 1).setValue(serializeDeviceEntries_(activeEntries));
        writeActiveCount_(sheet, header, sheetRow, activeEntries.length);
      }

      baseResult.headcountLimit = limitNum;
      baseResult.headcountUsed = activeEntries.length;
      baseResult.headcountRemaining = Math.max(limitNum - activeEntries.length, 0);
    }

    return Object.assign({ valid: valid }, baseResult);
  } finally {
    lock.releaseLock();
  }
}
