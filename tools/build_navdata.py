#!/usr/bin/env python3
"""Personal Wings nav-data builder.
Downloads the current FAA CIFP (ARINC 424) cycle and regenerates
  public/wx/navaids.json  fixes.json  airways.json  procedures.json
Run each 28-day AIRAC cycle:  python3 tools/build_navdata.py [YYMMDD]
If no cycle is given, it probes backward from today for the latest published cycle.
Requires: python3, curl, unzip. US-only (area code 'USA')."""
import json, os, sys, subprocess, tempfile, datetime
BASE="https://aeronav.faa.gov/Upload_313-d/CIFP/CIFP_%s.zip"
OUT=os.path.join(os.path.dirname(__file__),"..","public","wx")

def http_ok(url):
    r=subprocess.run(["curl","-s","-m","20","-o","/dev/null","-w","%{http_code}",url],capture_output=True,text=True)
    return r.stdout.strip()=="200"

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

def build(path):
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
                if not f: continue
                slot=procs[apt][sub][pid]
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
    print("wrote navaids=%d fixes=%d airways=%d airports_with_procs=%d -> %s"%(
        len(navaids),len(fixes),len(airways),len(out),os.path.abspath(OUT)))

def main():
    cyc=sys.argv[1] if len(sys.argv)>1 else find_cycle()
    print("CIFP cycle:",cyc)
    with tempfile.TemporaryDirectory() as td:
        z=os.path.join(td,"cifp.zip")
        if subprocess.run(["curl","-s","-m","120","-L","-o",z,BASE%cyc]).returncode!=0: sys.exit("download failed")
        subprocess.run(["unzip","-o","-q",z,"-d",td],check=True)
        f=[os.path.join(td,x) for x in os.listdir(td) if x.upper().startswith("FAACIFP")]
        if not f: sys.exit("FAACIFP file not found in archive")
        build(f[0])
    print("done. Commit public/wx/*.json and deploy.")

if __name__=="__main__": main()
