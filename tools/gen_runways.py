#!/usr/bin/env python3
"""
Personal Wings - regenerate netlify/functions/runways-data.js from the FAA NASR
"Airport" (APT) 28-day CSV subset. Authoritative, current runway-end coordinates
(the same source Jeppesen uses) so the airport diagram can anchor runway closures
to the REAL threshold instead of stale OpenStreetMap geometry.

Source (public, no key):
  https://nfdc.faa.gov/webContent/28DaySub/extra/<DD_Mon_YYYY>_APT_CSV.zip

The zip contains (modern NASR CSV layout):
  APT_BASE.csv     - one row per airport: SITE_NO, ARPT_ID (FAA ident), ICAO_ID, ARP LAT/LONG_DECIMAL
  APT_RWY.csv      - one row per runway:  SITE_NO, RWY_ID (e.g. "04/22"), RWY_LEN, RWY_WIDTH
  APT_RWY_END.csv  - one row per rwy END: SITE_NO, RWY_ID, RWY_END_ID (e.g. "04"),
                     LAT_DECIMAL/LONG_DECIMAL (threshold), DISPLACED_THR_LAT/LONG_DECIMAL,
                     TRUE_ALIGNMENT (true heading), RWY_END_ELEV

Emitted module (keyed by ICAO, US only):
  module.exports = { "KDIJ":[ {"id":"04/22","len":7301,"width":100,"ends":[
                       {"id":"04","lat":43.72,"lon":-111.10,"dlat":null,"dlon":null,"hdg":36,"elev":6163},
                       {"id":"22","lat":43.74,"lon":-111.08,"dlat":null,"dlon":null,"hdg":216,"elev":6257} ]} ], ... };

Usage:
  python3 tools/gen_runways.py                       # auto-detect current cycle, download, write
  python3 tools/gen_runways.py --date 2026-08-06
  python3 tools/gen_runways.py --csv-dir /path/to/extracted   # parse local CSVs, no download
  python3 tools/gen_runways.py --out some/other/runways-data.js

Exit codes: 0 ok, 2 sanity gate failed (too few airports -> caller must NOT commit),
3 download/parse error.
"""
import argparse, csv, datetime, io, json, os, re, sys, urllib.request, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO, "netlify", "functions", "runways-data.js")

# Same 28-day cycle anchor as the preferred-routes generator (FAA effective Thursdays).
ANCHOR = datetime.date(2026, 8, 6)
CYCLE_DAYS = 28
BASE_URL = "https://nfdc.faa.gov/webContent/28DaySub/extra/{tag}_APT_CSV.zip"
UA = "Mozilla/5.0 (PersonalWings NASR refresh) AppleWebKit/537.36"

# A schema break / empty download yields ~0 airports; the real US corpus is ~15-20k facilities
# with runway ends. Anything well below that means "do not ship".
MIN_AIRPORTS = 8000

def _canon(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

# NASR column names drift across releases; resolve each field from accepted aliases.
ALIASES = {
    # shared
    "site":  ["SITE_NO", "SITE_NUMBER", "ARPT_SITE_NO", "SITENO"],
    # APT_BASE
    "icao":  ["ICAO_ID", "ICAO_IDENT", "ICAO"],
    "faaid": ["ARPT_ID", "ARPT_IDENT", "LOCATION_IDENTIFIER", "LOC_ID", "FAA_ID"],
    "blat":  ["LAT_DECIMAL", "ARP_LAT_DECIMAL", "LATITUDE_DECIMAL"],
    "blon":  ["LONG_DECIMAL", "ARP_LONG_DECIMAL", "LONGITUDE_DECIMAL"],
    # APT_RWY
    "rwyid": ["RWY_ID", "RUNWAY_ID", "RWY_IDENT"],
    "len":   ["RWY_LEN", "PHYSICAL_RUNWAY_LENGTH", "RUNWAY_LENGTH", "RWY_LENGTH"],
    "width": ["RWY_WIDTH", "PHYSICAL_RUNWAY_WIDTH", "RUNWAY_WIDTH"],
    # APT_RWY_END
    "endid": ["RWY_END_ID", "RWY_END_IDENT", "RUNWAY_END_ID", "BASE_END_ID"],
    "elat":  ["LAT_DECIMAL", "RWY_END_LAT_DECIMAL", "LATITUDE_DECIMAL", "THR_LAT_DECIMAL"],
    "elon":  ["LONG_DECIMAL", "RWY_END_LONG_DECIMAL", "LONGITUDE_DECIMAL", "THR_LONG_DECIMAL"],
    "dlat":  ["DISPLACED_THR_LAT_DECIMAL", "DISPLACED_THR_LATITUDE_DECIMAL", "DISP_THR_LAT_DECIMAL"],
    "dlon":  ["DISPLACED_THR_LONG_DECIMAL", "DISPLACED_THR_LONGITUDE_DECIMAL", "DISP_THR_LONG_DECIMAL"],
    "hdg":   ["TRUE_ALIGNMENT", "RWY_END_TRUE_ALIGNMENT", "TRUE_HEADING", "TRUE_ALIGN"],
    "elev":  ["RWY_END_ELEV", "THR_ELEVATION", "ELEVATION", "TDZ_ELEV"],
    # DMS fallbacks (only used if *_DECIMAL is absent)
    "elat_dms": ["LATITUDE", "RWY_END_LATITUDE", "LAT"],
    "elon_dms": ["LONGITUDE", "RWY_END_LONGITUDE", "LONG"],
    "blat_dms": ["LATITUDE", "ARP_LATITUDE", "LAT"],
    "blon_dms": ["LONGITUDE", "ARP_LONGITUDE", "LONG"],
}

def resolve(header):
    idx = {_canon(h): i for i, h in enumerate(header)}
    out = {}
    for field, names in ALIASES.items():
        for n in names:
            c = _canon(n)
            if c in idx:
                out[field] = idx[c]
                break
    return out

def cell(row, hd, field):
    return row[hd[field]].strip() if field in hd and len(row) > hd[field] else ""

def to_float(s):
    if s is None: return None
    s = s.strip()
    if not s: return None
    try:
        return float(s)
    except ValueError:
        return None

# Parse an NASR DMS string like "43-44-48.1234N" or "111-05-30.0000W" -> signed decimal.
def dms_to_dec(s):
    if not s: return None
    m = re.match(r"\s*(\d+)[-\s](\d+)[-\s]([\d.]+)\s*([NSEW])", s.strip(), re.I)
    if not m: return None
    d, mi, se, hemi = int(m.group(1)), int(m.group(2)), float(m.group(3)), m.group(4).upper()
    val = d + mi / 60.0 + se / 3600.0
    if hemi in ("S", "W"): val = -val
    return val

def coord(row, hd, dec_field, dms_field):
    v = to_float(cell(row, hd, dec_field))
    if v is not None:
        return v
    return dms_to_dec(cell(row, hd, dms_field))

def to_int(s):
    v = to_float(s)
    return int(round(v)) if v is not None else None

# --- date/url helpers (identical convention to gen_prefroutes) ---------------
def current_cycle(today):
    n = (today - ANCHOR).days // CYCLE_DAYS
    return ANCHOR + datetime.timedelta(days=n * CYCLE_DAYS)

def tag_for(d):
    return d.strftime("%d_%b_%Y")   # e.g. 06_Aug_2026

def fetch_zip(d):
    url = BASE_URL.format(tag=tag_for(d))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        return url, r.read()

def read_csv_bytes(raw):
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return list(csv.reader(io.StringIO(raw.decode(enc))))
        except UnicodeDecodeError:
            continue
    return list(csv.reader(io.StringIO(raw.decode("utf-8", "replace"))))

def _pick(names, want):
    # find a member whose lowercased basename contains `want` and ends with .csv
    for n in names:
        low = n.lower()
        if low.endswith(".csv") and want in low.replace("\\", "/").split("/")[-1]:
            return n
    return None

def find_csvs_in_zip(zbytes):
    zf = zipfile.ZipFile(io.BytesIO(zbytes))
    names = zf.namelist()
    base = _pick(names, "apt_base")
    rwy  = _pick(names, "apt_rwy_end")   # check end first so "apt_rwy" doesn't grab it
    end  = rwy
    rwy2 = None
    for n in names:
        low = n.lower().split("/")[-1]
        if low.endswith(".csv") and "apt_rwy" in low and "end" not in low:
            rwy2 = n; break
    return (zf.read(base) if base else None,
            zf.read(rwy2) if rwy2 else None,
            zf.read(end) if end else None)

def find_csvs_in_dir(d):
    base = rwy = end = None
    for root, _, files in os.walk(d):
        for f in files:
            low = f.lower()
            if not low.endswith(".csv"): continue
            if "apt_base" in low: base = open(os.path.join(root, f), "rb").read()
            elif "apt_rwy_end" in low: end = open(os.path.join(root, f), "rb").read()
            elif "apt_rwy" in low: rwy = open(os.path.join(root, f), "rb").read()
    return base, rwy, end

# --- core build --------------------------------------------------------------
def build(base_b, rwy_b, end_b):
    brows = read_csv_bytes(base_b)
    if not brows: raise ValueError("APT_BASE.csv empty")
    bh = resolve(brows[0])
    print("APT_BASE header:", brows[0][:12], "...")
    print("resolved BASE:", {k: brows[0][v] for k, v in sorted(bh.items()) if v < len(brows[0])})
    for req in ("site",):
        if req not in bh: raise ValueError("APT_BASE.csv missing SITE_NO (header=%s)" % brows[0])

    # site -> ICAO ident and site -> FAA ident. Key the emitted data by BOTH so
    # ICAO fields (KDIJ) and FAA-ident-only fields (L35, 1A9) are all reachable.
    site_icao, site_faa = {}, {}
    for row in brows[1:]:
        if not row or "site" not in bh or len(row) <= bh["site"]: continue
        site = cell(row, bh, "site")
        if not site: continue
        icao = cell(row, bh, "icao").upper()
        faa = cell(row, bh, "faaid").upper()
        if faa: site_faa[site] = faa
        if not icao and re.fullmatch(r"[A-Z]{3}", faa):
            icao = "K" + faa
        if icao:
            site_icao[site] = icao

    # site -> { rwyid: {len,width} }
    rwy_meta = {}
    if rwy_b:
        rrows = read_csv_bytes(rwy_b)
        if rrows:
            rh = resolve(rrows[0])
            print("APT_RWY header:", rrows[0][:10], "...")
            print("resolved RWY:", {k: rrows[0][v] for k, v in sorted(rh.items()) if v < len(rrows[0])})
            for row in rrows[1:]:
                if not row or "site" not in rh or len(row) <= rh["site"]: continue
                site = cell(row, rh, "site"); rid = cell(row, rh, "rwyid").upper()
                if not site or not rid: continue
                rwy_meta.setdefault(site, {})[rid] = {"len": to_int(cell(row, rh, "len")),
                                                       "width": to_int(cell(row, rh, "width"))}

    # site,rwyid -> [ends]
    erows = read_csv_bytes(end_b)
    if not erows: raise ValueError("APT_RWY_END.csv empty")
    eh = resolve(erows[0])
    print("APT_RWY_END header:", erows[0][:14], "...")
    print("resolved RWY_END:", {k: erows[0][v] for k, v in sorted(eh.items()) if v < len(erows[0])})
    for req in ("site", "rwyid", "endid"):
        if req not in eh: raise ValueError("APT_RWY_END.csv missing '%s' (header=%s)" % (req, erows[0]))

    ends_by = {}   # (site,rwyid) -> [end dict]
    for row in erows[1:]:
        if not row or len(row) <= eh["endid"]: continue
        site = cell(row, eh, "site"); rid = cell(row, eh, "rwyid").upper(); eid = cell(row, eh, "endid").upper()
        if not site or not rid or not eid: continue
        lat = coord(row, eh, "elat", "elat_dms"); lon = coord(row, eh, "elon", "elon_dms")
        if lat is None or lon is None: continue
        dlat = to_float(cell(row, eh, "dlat")); dlon = to_float(cell(row, eh, "dlon"))
        e = {"id": eid, "lat": round(lat, 6), "lon": round(lon, 6),
             "dlat": round(dlat, 6) if dlat is not None else None,
             "dlon": round(dlon, 6) if dlon is not None else None,
             "hdg": to_int(cell(row, eh, "hdg")), "elev": to_int(cell(row, eh, "elev"))}
        ends_by.setdefault((site, rid), []).append(e)

    # assemble; key each airport by its ICAO and its FAA ident (same runway list under both)
    db = {}; sites_used = set()
    for (site, rid), ends in ends_by.items():
        icao = site_icao.get(site); faa = site_faa.get(site)
        keys = []
        if icao: keys.append(icao)
        if faa and faa != icao: keys.append(faa)
        if not keys: continue
        sites_used.add(site)
        meta = (rwy_meta.get(site) or {}).get(rid, {})
        rec = {"id": rid, "len": meta.get("len"), "width": meta.get("width"), "ends": ends}
        for k in keys:
            db.setdefault(k, []).append(rec)
    # stable order: runways sorted by id (de-dup identical runway rows a key may have collected)
    for k in db:
        seen, out = set(), []
        for r in sorted(db[k], key=lambda r: r["id"]):
            sig = r["id"]
            if sig in seen: continue
            seen.add(sig); out.append(r)
        db[k] = out
    return db, len(sites_used)

def emit(db, cycle_date):
    keys = sorted(db.keys())
    parts = [json.dumps(k) + ":" + json.dumps(db[k], separators=(",", ":"), ensure_ascii=False) for k in keys]
    header = ("// FAA NASR runway ends (cycle %s). Keyed ICAO (US). Each runway: "
              "{id,len,width,ends:[{id,lat,lon,dlat,dlon,hdg,elev}]}. dlat/dlon = displaced threshold.\n"
              % cycle_date.isoformat())
    return header + "module.exports={" + ",".join(parts) + "};\n"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="NASR effective date YYYY-MM-DD (default: current cycle)")
    ap.add_argument("--csv-dir", help="parse already-extracted CSVs here instead of downloading")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--min-airports", type=int, default=MIN_AIRPORTS)
    args = ap.parse_args()

    if args.csv_dir:
        base_b, rwy_b, end_b = find_csvs_in_dir(args.csv_dir)
        cycle = datetime.date.fromisoformat(args.date) if args.date else current_cycle(datetime.date.today())
        if not base_b or not end_b:
            print("ERROR: APT_BASE.csv / APT_RWY_END.csv not found under", args.csv_dir, file=sys.stderr); return 3
    else:
        if args.date:
            candidates = [datetime.date.fromisoformat(args.date)]
        else:
            cur = current_cycle(datetime.date.today())
            candidates = [cur, cur - datetime.timedelta(days=CYCLE_DAYS)]
        base_b = rwy_b = end_b = None; cycle = candidates[0]; last_err = None
        for c in candidates:
            try:
                url, zbytes = fetch_zip(c)
                base_b, rwy_b, end_b = find_csvs_in_zip(zbytes)
                if base_b and end_b:
                    cycle = c; print("downloaded", url, "(%d bytes)" % len(zbytes)); break
            except Exception as e:  # noqa
                last_err = e
        if not base_b or not end_b:
            print("ERROR: could not download/parse APT CSV:", last_err, file=sys.stderr); return 3

    db, nsites = build(base_b, rwy_b, end_b)
    print("cycle %s -> %d airports (sites), %d lookup keys" % (cycle.isoformat(), nsites, len(db)))
    if "KDIJ" in db: print("KDIJ sample:", json.dumps(db["KDIJ"]))
    if "L35" in db: print("L35 sample:", json.dumps(db["L35"]))
    if nsites < args.min_airports:
        print("SANITY GATE FAILED: %d airports < %d minimum. NOT writing." % (nsites, args.min_airports), file=sys.stderr)
        return 2

    out = emit(db, cycle)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        f.write(out)
    print("wrote", args.out, "(%d bytes)" % len(out))
    return 0

if __name__ == "__main__":
    sys.exit(main())
