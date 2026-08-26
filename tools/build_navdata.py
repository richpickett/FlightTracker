#!/usr/bin/env python3
"""Personal Wings nav-data builder.
Downloads the current FAA CIFP (ARINC 424) cycle and regenerates
  navaids.json  fixes.json  airways.json  procedures.json
Run each 28-day AIRAC cycle:  python3 tools/build_navdata.py [YYMMDD]
If no cycle is given, it probes backward from today for the latest published cycle.
Requires: python3, curl, unzip. US-only (area code 'USA')."""
import json, os, sys, subprocess, tempfile, datetime, re, zipfile, time
import xml.etree.ElementTree as ET
BASE="https://aeronav.faa.gov/Upload_313-d/CIFP/CIFP_%s.zip"
# Output dir. The Suite keeps nav-data SOURCE in src/backbone/wx (build_suite.py copies it to public/wx at deploy);
# FlightTracker serves public/wx directly. Auto-detect so the SAME script works unchanged in both repos.
_REPO=os.path.join(os.path.dirname(__file__),"..")
_SRC=os.path.join(_REPO,"src","backbone","wx")
OUT=_SRC if os.path.isdir(_SRC) else os.path.join(_REPO,"public","wx")

def http_ok(url, tries=3):
    # Probe a cycle URL. 200 -> present; 404 -> definitively not this cycle (let caller step back a day);
    # anything else (000 conn-fail / 5xx) is transient -> retry with backoff before giving up on this URL.
    delay=3
    for i in range(tries):
        r=subprocess.run(["curl","-s","-m","20","-o","/dev/null","-w","%{http_code}",url],capture_output=True,text=True)
        code=r.stdout.strip()
        if code=="200": return True
        if code=="404": return False
        if i<tries-1: time.sleep(delay); delay*=2
    return False

def find_cycle():
    d=datetime.date.today()
    for _ in range(35):
        c=d.strftime("%y%m%d")
        if http_ok(BASE%c): return c
        d-=datetime.timedelta(days=1)
    sys.exit("Could not find a published CIFP cycle in the last 35 days.")

def dms_lat(s): return (int(s[1:3])+int(s[3:5])/60.0+(int(s[5:7])+int(s[7:9])/100.0)/3600.0)*(-1 if s[0]=='S' else 1)
def dms_lon(s): return (int(s[1:4])+int(s[4:6])/60.0+(int(s[6:8])+int(s[8:10])/100.0)/3600.0)*(-1 if s[0]=='W' else 1)
def ll(line):
    la=line[32:41]; lo=line[41:51]
    if la[:1] in 'NS' and lo[:1] in 'EW':
        try: return [round(dms_lat(la),5),round(dms_lon(lo),5)]
        except: return None
    return None

# --- Procedures the FAA charts but does NOT encode in the CIFP (radar-vector SIDs, special RNP, etc.).
# The CIFP zip ships this as "Not_In_CIFP_<cycle>.xlsx". We emit procedures-excluded.json so the app can tell
# "charted but not coded — fly the plate" apart from "unknown identifier — verify". Stdlib-only xlsx reader (no openpyxl).
_XNS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
def _xlsx_rows(path):
    with zipfile.ZipFile(path) as z:
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall(_XNS+'si'):
                shared.append(''.join(t.text or '' for t in si.iter(_XNS+'t')))
        sheet=sorted(n for n in z.namelist() if n.startswith('xl/worksheets/sheet'))[0]
        rows=[]
        for row in ET.fromstring(z.read(sheet)).iter(_XNS+'row'):
            cells=[]
            for c in row.findall(_XNS+'c'):
                v=c.find(_XNS+'v')
                if v is not None:
                    val=v.text or ''
                    if c.get('t')=='s': val=shared[int(val)]
                else:
                    is_=c.find(_XNS+'is'); val=''.join(x.text or '' for x in is_.iter(_XNS+'t')) if is_ is not None else ''
                cells.append(val)
            rows.append(cells)
        return rows
def excluded_procs(xlsx_path):
    from collections import defaultdict
    excl=defaultdict(set)
    for r in _xlsx_rows(xlsx_path)[1:]:              # row 0 is the header (ARINC_ID, TERM_ID)
        if len(r)>=2 and r[0] and r[1]:
            apt=r[0].strip().upper()
            base=re.sub(r'\d+$','',r[1].strip().upper())   # strip trailing revision digit(s): CHRLY7 -> CHRLY
            if re.fullmatch(r'[A-Z]{3,6}', base):           # keep SID/STAR-style names (matches the client's looksProc)
                excl[apt].add(base)
    return {k:sorted(v) for k,v in sorted(excl.items())}

def build(path, xlsx_path=None):
    from collections import defaultdict
    navaids={}; fixes={}
    proc=lambda: {'common':[],'rwy':{},'enr':{}}
    procs=defaultdict(lambda: defaultdict(lambda: defaultdict(proc)))
    awy=defaultdict(list)
    for line in open(path,encoding='latin-1'):
        if line[:1]!='S' or line[1:4]!='USA': continue
        sec=line[4]
        if sec=='D':
            i=line[13:17].strip(); c=ll(line)
            if i and c and i not in navaids: navaids[i]=c
        elif sec=='E' and line[5]=='A':
            i=line[13:18].strip(); c=ll(line)
            if i and c: fixes[i]=c
        elif sec=='E' and line[5]=='R':
            rid=line[13:19].strip()
            try: seq=int(line[25:29])
            except: continue
            f=line[29:34].strip()
            if rid and f: awy[rid].append((seq,f))
        elif sec=='P':
            sub=line[12]
            if sub=='C':
                i=line[13:18].strip(); c=ll(line)
                if i and c and i not in fixes: fixes[i]=c
            elif sub=='N':
                i=line[13:18].strip(); c=ll(line)
                if i and c and i not in navaids: navaids[i]=c
            elif sub in ('D','E'):
                apt=line[6:10].strip(); pid=line[13:19].strip()
                tr=line[20:25].strip(); f=line[29:34].strip()
                slot=procs[apt][sub][pid]   # register the procedure FIRST so heading/vector SIDs (KMRY MRY5: VA/VM legs, no fix) are known, not "not found"
                if not f: continue           # this particular leg is a heading/altitude leg with no named fix — nothing to add, but the procedure now exists
                if tr[:2]=='RW' or tr=='ALL': slot['rwy'].setdefault(tr,[]).append(f)
                elif tr=='': slot['common'].append(f)
                else: slot['enr'].setdefault(tr,[]).append(f)
    def dd(a):
        o=[]; [o.append(x) for x in a if not o or o[-1]!=x]; return o
    airways={}
    for rid,lst in awy.items():
        lst.sort(); airways[rid]=dd([f for _,f in lst])
    out={}
    for apt,types in procs.items():
        out[apt]={}
        for t,ps in types.items():
            out[apt][t]={}
            for pid,slot in ps.items():
                out[apt][t][pid]={'common':dd(slot['common']),
                    'rwy':{k:dd(v) for k,v in slot['rwy'].items()},
                    'enr':{k:dd(v) for k,v in slot['enr'].items()}}
    w=lambda n,o: json.dump(o,open(os.path.join(OUT,n),'w'),separators=(',',':'))
    w('navaids.json',navaids); w('fixes.json',fixes); w('airways.json',airways); w('procedures.json',out)
    excl={}
    if xlsx_path and os.path.exists(xlsx_path):
        try: excl=excluded_procs(xlsx_path); w('procedures-excluded.json',excl)
        except Exception as e: print("WARN: could not parse Not_In_CIFP xlsx:",e)
    print("wrote navaids=%d fixes=%d airways=%d airports_with_procs=%d excluded_airports=%d -> %s"%(
        len(navaids),len(fixes),len(airways),len(out),len(excl),os.path.abspath(OUT)))

def main():
    cyc=sys.argv[1] if len(sys.argv)>1 else find_cycle()
    print("CIFP cycle:",cyc)
    with tempfile.TemporaryDirectory() as td:
        z=os.path.join(td,"cifp.zip")
        dl_ok=False
        for i in range(4):   # -f => non-zero exit on 5xx, so a transient FAA hiccup is retried, not fatal
            if subprocess.run(["curl","-fsS","-m","120","-L","-o",z,BASE%cyc]).returncode==0: dl_ok=True; break
            if i<3: print("  download failed — retry %d/3 in %ds"%(i+1,3*(i+1))); time.sleep(3*(i+1))
        if not dl_ok: sys.exit("download failed after retries")
        subprocess.run(["unzip","-o","-q",z,"-d",td],check=True)
        f=[os.path.join(td,x) for x in os.listdir(td) if x.upper().startswith("FAACIFP")]
        if not f: sys.exit("FAACIFP file not found in archive")
        xl=[os.path.join(td,x) for x in os.listdir(td) if x.upper().startswith("NOT_IN_CIFP") and x.lower().endswith(".xlsx")]
        build(f[0], xl[0] if xl else None)
    print("done. Commit the regenerated *.json under %s and deploy."%os.path.relpath(OUT,_REPO))

if __name__=="__main__": main()
