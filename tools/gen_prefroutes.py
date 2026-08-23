#!/usr/bin/env python3
"""
Personal Wings - regenerate netlify/functions/prefroutes-data.js from the FAA
NASR "Preferred Route / TEC" (PFR) 28-day CSV subset.

Source (public, no key):
  https://nfdc.faa.gov/webContent/28DaySub/extra/<DD_Mon_YYYY>_PFR_CSV.zip

The zip contains PFR_BASE.csv (one row per route: origin, dest, type, altitude,
aircraft, hours) and PFR_SEG.csv (one row per route element: the fixes/airways
that make up the route string). We group segments by route, join them into the
route string, map the FAA type code to hi/lo, and emit the same JSON module the
app already consumes:

  module.exports = { "ABE-ACY":[{"t":"TEC","cat":"lo","r":"FJC ARD CYN",
                                 "alt":"5000","ac":"","hrs":""}], ... };

Usage:
  python3 tools/gen_prefroutes.py                 # auto-detect current cycle, download, write
  python3 tools/gen_prefroutes.py --date 2026-08-06
  python3 tools/gen_prefroutes.py --csv-dir /path/to/extracted   # parse local CSVs, no download
  python3 tools/gen_prefroutes.py --out some/other/prefroutes-data.js

Exit codes: 0 ok, 2 sanity gate failed (too few routes -> caller must NOT commit),
3 download/parse error.
"""
import argparse, csv, datetime, io, json, os, re, sys, time, urllib.request, urllib.error, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO, "netlify", "functions", "prefroutes-data.js")

# A known real NASR effective date; every cycle is 28 days from here (Thursdays).
ANCHOR = datetime.date(2026, 8, 6)
CYCLE_DAYS = 28
BASE_URL = "https://nfdc.faa.gov/webContent/28DaySub/extra/{tag}_PFR_CSV.zip"
UA = "Mozilla/5.0 (PersonalWings NASR refresh) AppleWebKit/537.36"

# Minimum plausible route count. A schema break / empty download yields ~0, so
# anything well below the real corpus (~8,000 city-pairs) means "do not ship".
MIN_PAIRS = 5000

# --- column resolution -------------------------------------------------------
# NASR column names have shifted across releases; resolve each field from a list
# of accepted aliases (case-insensitive, ignoring spaces/underscores).
def _canon(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

ALIASES = {
    "orig":    ["ORIGIN_ID", "ORIG_ID", "ORIGIN", "PFR_ORIG_ID", "ORIG"],
    "dest":    ["DSTN_ID", "DEST_ID", "DESTINATION_ID", "PFR_DSTN_ID", "DSTN", "DEST"],
    "type":    ["PFR_TYPE_CODE", "PREF_ROUTE_TYPE_CODE", "TYPE_CODE", "ROUTE_TYPE", "PFR_TYPE"],
    "routeno": ["ROUTE_NO", "ROUTE_ID", "PREF_ROUTE_ID", "ROUTE_NUM", "ROUTE_NO_ID"],
    "alt":     ["ALTITUDE_DESCRIPTION", "ALT_DESC", "ALTITUDE", "ALT_DESCRIPTION", "ALTITUDE_DESC"],
    "ac":      ["AIRCRAFT", "AIRCRAFT_DESCRIPTION", "AIRCRAFT_DESC", "ACFT"],
    "hrs":     ["HOURS", "HRS", "TIME_OF_OPERATION", "HOURS_OF_OPERATION"],
    # PFR_SEG only:
    "seq":     ["SEG_SEQ_NO", "SEGMENT_SEQ", "SEG_SEQ", "SEQ_NO", "SEGMENT_NO", "SEG_NO"],
    "segval":  ["SEG_VALUE", "SEGMENT_STRING", "SEG_TEXT", "SEGMENT_VALUE", "NAV_ID",
                "NAS_ID", "WAYPOINT", "SEGMENT", "SEG_STRING", "FIX_ID"],
    # optional single-file fallback: full route text living on the base row
    "routetext": ["ROUTE_STRING", "SEGMENT_TEXT", "ROUTE", "ROUTE_TEXT", "FULL_ROUTE"],
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

# --- type -> hi/lo -----------------------------------------------------------
def cat_of(t):
    t = (t or "").upper()
    if t in ("TEC", "SEA", "SLD"):
        return "lo"
    if t == "NAR":
        return "hi"
    if "H" in t:
        return "hi"
    if "L" in t:
        return "lo"
    return "hi"

# --- date/url helpers --------------------------------------------------------
def current_cycle(today):
    n = (today - ANCHOR).days // CYCLE_DAYS
    return ANCHOR + datetime.timedelta(days=n * CYCLE_DAYS)

def tag_for(d):
    # FAA uses e.g. 06_Aug_2026
    return d.strftime("%d_%b_%Y")

def _http_get(url, timeout, attempts=4):
    """GET with retry + exponential backoff on transient failures (5xx / timeout / connection reset).
    A 4xx (e.g. 404 'cycle not posted yet') propagates immediately so the caller's cycle-fallback can try an older tag —
    only genuinely transient server errors are retried. FAA NASR endpoints flake with 503s; this rides them out."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    delay = 3
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code >= 500 and i < attempts - 1:
                sys.stderr.write("  transient HTTP %d on %s — retry %d/%d in %ds\n" % (e.code, url, i+1, attempts-1, delay)); sys.stderr.flush()
                time.sleep(delay); delay *= 2; continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            if i < attempts - 1:
                sys.stderr.write("  transient %s on %s — retry %d/%d in %ds\n" % (getattr(e, "reason", e), url, i+1, attempts-1, delay)); sys.stderr.flush()
                time.sleep(delay); delay *= 2; continue
            raise
    raise RuntimeError("unreachable")

def fetch_zip(d):
    url = BASE_URL.format(tag=tag_for(d))
    return url, _http_get(url, 120)

# --- CSV loading -------------------------------------------------------------
def read_csv_bytes(raw):
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return list(csv.reader(io.StringIO(raw.decode(enc))))
        except UnicodeDecodeError:
            continue
    return list(csv.reader(io.StringIO(raw.decode("utf-8", "replace"))))

def find_csvs_in_zip(zbytes):
    zf = zipfile.ZipFile(io.BytesIO(zbytes))
    base = seg = None
    for name in zf.namelist():
        low = name.lower()
        if low.endswith(".csv") and "pfr_base" in low:
            base = zf.read(name)
        elif low.endswith(".csv") and "pfr_seg" in low:
            seg = zf.read(name)
    return base, seg

def find_csvs_in_dir(d):
    base = seg = None
    for root, _, files in os.walk(d):
        for f in files:
            low = f.lower()
            if low.endswith(".csv") and "pfr_base" in low:
                base = open(os.path.join(root, f), "rb").read()
            elif low.endswith(".csv") and "pfr_seg" in low:
                seg = open(os.path.join(root, f), "rb").read()
    return base, seg

# --- core build --------------------------------------------------------------
def build(base_bytes, seg_bytes):
    brows = read_csv_bytes(base_bytes)
    if not brows:
        raise ValueError("PFR_BASE.csv empty")
    bh = resolve(brows[0])
    for req in ("orig", "dest", "type"):
        if req not in bh:
            raise ValueError("PFR_BASE.csv missing column for '%s' (header=%s)" % (req, brows[0]))
    # The altitude column name has drifted across NASR releases and isn't in the public
    # CSV mapping doc — if no alias matched, grab any still-unused header containing 'alt'.
    if "alt" not in bh:
        used = set(bh.values())
        for i, h in enumerate(brows[0]):
            if i not in used and "alt" in _canon(h):
                bh["alt"] = i
                break
    print("PFR_BASE header:", brows[0])
    print("resolved BASE columns:", {k: brows[0][v] for k, v in sorted(bh.items())})

    # Assemble route strings from PFR_SEG grouped by (orig,dest,type,routeno).
    seg_by_route = {}
    if seg_bytes:
        srows = read_csv_bytes(seg_bytes)
        if srows:
            sh = resolve(srows[0])
            print("PFR_SEG header:", srows[0])
            print("resolved SEG columns:", {k: srows[0][v] for k, v in sorted(sh.items())})
            if "segval" in sh:
                for row in srows[1:]:
                    if not row or len(row) <= sh["segval"]:
                        continue
                    key = (
                        (row[sh["orig"]] if "orig" in sh and len(row) > sh["orig"] else "").strip().upper(),
                        (row[sh["dest"]] if "dest" in sh and len(row) > sh["dest"] else "").strip().upper(),
                        (row[sh["type"]] if "type" in sh and len(row) > sh["type"] else "").strip().upper(),
                        (row[sh["routeno"]] if "routeno" in sh and len(row) > sh["routeno"] else "").strip(),
                    )
                    try:
                        seq = int(re.sub(r"[^0-9]", "", row[sh["seq"]]) or "0") if "seq" in sh and len(row) > sh["seq"] else len(seg_by_route.get(key, []))
                    except ValueError:
                        seq = 0
                    val = row[sh["segval"]].strip()
                    if val:
                        seg_by_route.setdefault(key, []).append((seq, val))

    def route_string(row):
        key = (
            row[bh["orig"]].strip().upper(),
            row[bh["dest"]].strip().upper(),
            row[bh["type"]].strip().upper(),
            (row[bh["routeno"]].strip() if "routeno" in bh and len(row) > bh["routeno"] else ""),
        )
        segs = seg_by_route.get(key)
        if segs:
            return " ".join(v for _, v in sorted(segs, key=lambda x: x[0])).strip()
        if "routetext" in bh and len(row) > bh["routetext"]:
            return re.sub(r"\s+", " ", row[bh["routetext"]].strip())
        return ""

    def cell(row, field):
        return row[bh[field]].strip() if field in bh and len(row) > bh[field] else ""

    db = {}
    for row in brows[1:]:
        if not row or len(row) <= bh["dest"]:
            continue
        o = row[bh["orig"]].strip().upper()
        d = row[bh["dest"]].strip().upper()
        t = row[bh["type"]].strip().upper()
        if not o or not d or not t:
            continue
        rec = {
            "t": t,
            "cat": cat_of(t),
            "r": route_string(row),
            "alt": cell(row, "alt"),
            "ac": cell(row, "ac"),
            "hrs": cell(row, "hrs"),
        }
        db.setdefault(o + "-" + d, []).append(rec)
    # Drop exact-duplicate route rows within a pair (NASR can list a route twice); keep order.
    for k in db:
        seen, out = set(), []
        for r in db[k]:
            sig = (r["t"], r["cat"], r["r"], r["alt"], r["ac"], r["hrs"])
            if sig in seen:
                continue
            seen.add(sig); out.append(r)
        db[k] = out
    return db

def emit(db, cycle_date):
    keys = sorted(db.keys())
    parts = []
    for k in keys:
        parts.append(json.dumps(k) + ":" + json.dumps(db[k], separators=(",", ":"), ensure_ascii=False))
    header = ("// FAA NASR Preferred Routes (cycle %s). Keyed ORIG-DEST (3-letter idents). "
              "cat: hi=high-alt(jet), lo=low-alt(piston/turboprop).\n" % cycle_date.isoformat())
    return header + "module.exports={" + ",".join(parts) + "};\n"

# --- main --------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="NASR effective date YYYY-MM-DD (default: current cycle)")
    ap.add_argument("--csv-dir", help="parse already-extracted CSVs here instead of downloading")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--min-pairs", type=int, default=MIN_PAIRS)
    args = ap.parse_args()

    if args.csv_dir:
        base_b, seg_b = find_csvs_in_dir(args.csv_dir)
        cycle = datetime.date.fromisoformat(args.date) if args.date else current_cycle(datetime.date.today())
        if not base_b:
            print("ERROR: PFR_BASE.csv not found under", args.csv_dir, file=sys.stderr)
            return 3
    else:
        if args.date:
            cycle = datetime.date.fromisoformat(args.date)
            candidates = [cycle]
        else:
            cur = current_cycle(datetime.date.today())
            candidates = [cur, cur - datetime.timedelta(days=CYCLE_DAYS)]  # fall back one cycle if new one not posted yet
        base_b = seg_b = None
        cycle = candidates[0]
        last_err = None
        for c in candidates:
            try:
                url, zbytes = fetch_zip(c)
                base_b, seg_b = find_csvs_in_zip(zbytes)
                if base_b:
                    cycle = c
                    print("downloaded", url, "(%d bytes)" % len(zbytes))
                    break
            except Exception as e:  # noqa
                last_err = e
        if not base_b:
            print("ERROR: could not download/parse PFR CSV:", last_err, file=sys.stderr)
            return 3

    db = build(base_b, seg_b)
    pairs = len(db)
    routes = sum(len(v) for v in db.values())
    altpop = sum(1 for k in db for r in db[k] if r["alt"])
    print("cycle %s -> %d city-pairs, %d routes (%d with altitude)" % (cycle.isoformat(), pairs, routes, altpop))
    if pairs < args.min_pairs:
        print("SANITY GATE FAILED: %d pairs < %d minimum. NOT writing." % (pairs, args.min_pairs), file=sys.stderr)
        return 2

    out = emit(db, cycle)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        f.write(out)
    print("wrote", args.out, "(%d bytes)" % len(out))
    return 0

if __name__ == "__main__":
    sys.exit(main())
