/**
 * 交通出門助手——公車到站秒數 Worker。
 * 台北市、新北市的開放資料不允許瀏覽器跨網域讀取，整包也太大（約 2MB）不適合長輩手機一直下載，
 * 所以由這支 Worker 代抓，只回傳指定站牌的秒數。上游網址寫死，不是開放代理，也不記錄任何使用者資料。
 *
 * GET /eta?t=187095,187096&n=213893   t＝台北資料 StopID，n＝新北資料 StopID，合計最多 30 個
 * 回應：{ ok, r:{ "187095":245, "213893":-1 }, tpAt:"2026/11/04 22:40:05"|null, miss:["t"] }
 * 秒數意義：>=0 預估秒數；-1 尚未發車；-2 交管不停靠；-3 末班已過；-4 今日未營運。查不到的 ID 不會出現在 r。
 *
 * 白名單：Origin 不在 ALLOWED（含沒帶 Origin，例如 curl、直接開網址）一律回 403，不會去抓上游。
 * 手動測試要自己帶標頭：curl -H "Origin: https://m255525.github.io" ...
 */
const ALLOWED = ['https://m255525.github.io', 'http://localhost:8852', 'http://127.0.0.1:8852'];
const TP_URL = 'https://tcgbusfs.blob.core.windows.net/blobbus/GetEstimateTime.gz';
const NT_URL = 'https://data.ntpc.gov.tw/api/datasets/07f7ccb3-ed00-43c4-966d-08e9dab24e95/csv/file';
const TTL = 25;              // 邊緣快取秒數；資料源本身約 20～60 秒更新一次
const MAX_IDS = 30;
const mem = { t: null, n: null };   // 同一個 isolate 內的短期快取，省掉重複解壓

function cors(origin) {
  const h = { Vary: 'Origin' };
  if (ALLOWED.includes(origin)) { h['Access-Control-Allow-Origin'] = origin; h['Access-Control-Allow-Methods'] = 'GET, OPTIONS'; }
  return h;
}
function json(obj, status, origin, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin), ...(extra || {}) } });
}
async function load(which) {
  const c = mem[which], now = Date.now();
  if (c && now - c.at < TTL * 1000) return c.text;
  const res = await fetch(which === 't' ? TP_URL : NT_URL, {
    cf: { cacheEverything: true, cacheTtl: TTL },
    headers: { 'User-Agent': 'next-bus-helper' },
  });
  if (!res.ok) throw new Error('upstream ' + res.status);
  let text;
  if (which === 't') {
    const raw = await res.arrayBuffer();
    const head = new Uint8Array(raw, 0, 2);
    const body = head[0] === 0x1f && head[1] === 0x8b
      ? new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip')))
      : new Response(raw);
    text = await body.text();
  } else {
    text = await res.text();
  }
  mem[which] = { at: now, text, sig: which === 'n' ? await digest(text) : null };
  return text;
}
/* 新北資料沒有時間欄位，資料停住時看不出來（2026-11-05 實測整份檔案 13 分鐘沒變）。
   回傳檔案指紋讓前端判斷；狀態放前端，因為這裡的記憶體會隨 isolate 回收消失。 */
async function digest(text) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function pickTp(text, id) {
  const key = '"StopID":' + id + ',"EstimateTime":"';
  const i = text.indexOf(key);
  if (i < 0) return undefined;
  const a = i + key.length;
  return parseInt(text.slice(a, text.indexOf('"', a)), 10);
}
function pickNt(text, id) {
  const key = ',' + id + ',';
  const i = text.indexOf(key);
  if (i < 0) return undefined;
  const a = i + key.length;
  return parseInt(text.slice(a, text.indexOf(',', a)), 10);
}
function ids(s) {
  return String(s || '').split(',').filter((x) => /^\d{1,9}$/.test(x));
}

export default {
  async fetch(request) {
    const url = new URL(request.url), origin = request.headers.get('Origin') || '';
    if (!ALLOWED.includes(origin)) return json({ ok: false, error: 'forbidden' }, 403, origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET' || url.pathname !== '/eta') return json({ ok: false, error: 'not found' }, 404, origin);
    const t = ids(url.searchParams.get('t')), n = ids(url.searchParams.get('n'));
    if (!t.length && !n.length) return json({ ok: false, error: 'no ids' }, 400, origin);
    if (t.length + n.length > MAX_IDS) return json({ ok: false, error: 'too many ids' }, 400, origin);
    const r = {}, miss = [];
    let tpAt = null, ntSig = null;
    await Promise.all([
      t.length ? load('t').then((text) => {
        for (const id of t) { const v = pickTp(text, id); if (Number.isFinite(v)) r[id] = v; }
        const m = /"UpdateTime":"([^"]+)"/.exec(text.slice(0, 400)); if (m) tpAt = m[1];
      }).catch(() => miss.push('t')) : null,
      n.length ? load('n').then((text) => {
        for (const id of n) { const v = pickNt(text, id); if (Number.isFinite(v)) r[id] = v; }
        ntSig = mem.n.sig;
      }).catch(() => miss.push('n')) : null,
    ]);
    const ok = miss.length < (t.length ? 1 : 0) + (n.length ? 1 : 0);
    return json({ ok, r, tpAt, ntSig, miss }, ok ? 200 : 502, origin, { 'Cache-Control': 'public, max-age=15' });
  },
};
