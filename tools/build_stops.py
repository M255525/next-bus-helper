# 產生 stops-data.json：台北市＋新北市公車「站牌→路線」索引（只用標準函式庫，GitHub Actions 每週也跑這支）
# 格式：{"v":日期,"p":[[站名,緯度,經度,地址]],"r":[[路線名,往哪,"t"|"n",[站牌索引...],[StopID...],班次]]}
# 班次＝[平日首班,平日末班,假日首班,假日末班,尖峰班距,離峰班距,假日尖峰班距,假日離峰班距]，都是 4 碼字串（時間 HHMM、班距 0715＝7～15 分），沒資料為 ""。
# 首末班是起站發車時間，不是各站到站時間。開放資料沒有完整的逐班時刻表，所以不收 GetTimeTable（不分去返程且多數路線不完整）。
# StopID 就是 Worker /eta 查到站時間用的 ID；"t"＝台北資料、"n"＝新北資料。兩邊 ID 不重疊。
import gzip, json, os, sys, urllib.request, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'stops-data.json')
TP = 'https://tcgbusfs.blob.core.windows.net/blobbus/'
NT = 'https://data.ntpc.gov.tw/api/datasets/'
NT_ROUTE, NT_STOP = '0ee4e6bf-cee6-4ec8-8fe1-71f544015127', '34b402a8-53d9-483d-9406-24a682c2d6dc'

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'next-bus-helper-build'})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()
def svc(g, go):
    """從路線資料取這個方向的班次。g(key) 依欄位名取值，key 用小寫，兩市共用。"""
    d = 'go' if go == '0' else 'back'
    def v(k):
        x = str(g(k) or '').strip()
        return x if len(x) == 4 and x.isdigit() else ''
    return [v(d + 'firstbustime'), v(d + 'lastbustime'), v('holiday' + d + 'firstbustime'), v('holiday' + d + 'lastbustime'),
            v('peakheadway'), v('offpeakheadway'), v('holidaypeakheadway'), v('holidayoffpeakheadway')]
def tp(name):
    b = get(TP + name + '.gz')
    if b[:2] == b'\x1f\x8b': b = gzip.decompress(b)
    return json.loads(b.decode('utf-8-sig'))['BusInfo']
def nt(ds):
    rows, page = [], 0
    while True:
        part = json.loads(get(f'{NT}{ds}/json?page={page}&size=50000').decode('utf-8-sig'))
        rows += part
        if len(part) < 50000: return rows
        page += 1

places, pidx, groups = [], {}, {}
def add(city, route, go, seq, sid, name, lat, lon, addr, loc):
    k = (city, loc)
    if k not in pidx:
        pidx[k] = len(places)
        places.append([name, round(float(lat), 5), round(float(lon), 5), (addr or '').strip()])
    groups.setdefault((city, route, go), []).append((int(seq), pidx[k], int(sid)))

routes = {}
for r in tp('GetRoute'):
    low = {k.lower(): x for k, x in r.items()}
    routes.setdefault(('t', str(r['Id'])), (r['nameZh'], r['departureZh'], r['destinationZh'], low.get))
for s in tp('GetStop'):
    add('t', str(s['routeId']), str(s['goBack']), s['seqNo'], s['Id'], s['nameZh'], s['showLat'], s['showLon'], s.get('address'), s['stopLocationId'])
for r in nt(NT_ROUTE):
    routes.setdefault(('n', str(r['id'])), (r['namezh'], r['departurezh'], r['destinationzh'], r.get))
for s in nt(NT_STOP):
    add('n', s['routeid'], s['goback'], s['seqno'], s['id'], s['namezh'], s['showlat'], s['showlon'], s.get('address'), s['stoplocationid'])

out = []
for (city, route, go), rows in groups.items():
    info = routes.get((city, route))
    if not info or len(rows) < 2: continue
    rows.sort()
    name, dep, dest, g = info
    head = dest if go == '0' else dep
    if not head: head = places[rows[-1][1]][0]
    out.append([name, head, city, [x[1] for x in rows], [x[2] for x in rows], svc(g, go)])
out.sort(key=lambda x: (x[0], x[1]))

n_t = sum(1 for x in out if x[2] == 't'); n_n = len(out) - n_t
print('places', len(places), 'route-dirs', len(out), 't', n_t, 'n', n_n)
if n_t < 500 or n_n < 500 or len(places) < 10000:
    sys.exit('資料量異常，不覆寫 stops-data.json')
tz = datetime.timezone(datetime.timedelta(hours=8))
data = {'v': datetime.datetime.now(tz).strftime('%Y-%m-%d'), 'p': places, 'r': out}
with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
print('bytes', os.path.getsize(OUT))
