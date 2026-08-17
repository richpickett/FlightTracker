/* Personal Wings — Airport diagram with NOTAM closures highlighted (in-app modal).
   Geometry from OpenStreetMap (aeroway); closures parsed from the airport's NOTAMs.
   Accuracy features:
     • Taxiway "BTN <x> AND <y>" closures draw only the clipped segment (crossing-based).
     • Partial runway closures ("SW 3451 FT") draw only that stretch, to scale.
     • Displaced thresholds ("RWY 19 THR DISPLACED 300FT") mark the displaced distance from the end.
   Wire: notamtri.js stashes window.__pwdiag[ICAO]={lat,lon,items:[{text}]}; a button calls PWDiagram.open('KSFO').
   Requires Leaflet (already loaded by the briefing/map pages).
*/
(function (w) {

  // ===== Parsers =============================================================
  function boundRef(s){ // "APCH END RWY 19L" / "RWY 01L/19R" / "TWY L" -> {type,id}
    s=(s||'').toUpperCase().trim();
    var m=s.match(/RWY\s+([0-9]{1,2}[LRC]?(?:\/[0-9]{1,2}[LRC]?)?)/);
    if(m) return {type:'rwy',id:m[1]};
    m=s.match(/TWY\s+([A-Z]\d?)/);
    if(m) return {type:'twy',id:m[1]};
    return null;
  }
  // Closed taxiways as clauses: {twy, from, to}  (from/to = boundRef or null => whole taxiway closed)
  function closedTwySegs(text){
    var t=(text||'').toUpperCase();
    if(!/\bCLSD\b/.test(t)) return [];
    if(/\bRWY\b[^.]{0,60}\bCLSD\b/.test(t) && !/\bTWY\b[^.]{0,60}\bCLSD\b/.test(t)) return [];
    if(t.length>420) t=t.slice(0,420);
    var out=[], m;
    // Pass 1 — segment clauses "TWY <id> BTN <ref1> AND <ref2>". Blank them out afterwards.
    var refPat='((?:APCH\\s+END\\s+)?(?:RWY|TWY)\\s+[A-Z0-9\\/]+)';
    var segRe=new RegExp('\\bTWY\\s+([A-Z]\\d?)\\s+BTN\\s+'+refPat+'\\s+AND\\s+'+refPat,'g');
    var blanked=t;
    while(m=segRe.exec(t)){
      out.push({twy:m[1],from:boundRef(m[2]),to:boundRef(m[3])});
      blanked=blanked.slice(0,m.index)+' '.repeat(m[0].length)+blanked.slice(m.index+m[0].length);
    }
    // Pass 2 — remaining bare "TWY <id>[, id, id]" are whole-taxiway closures.
    var cleaned=blanked.replace(/\bBTN\b[^,;.]{0,40}\bAND\b\s*(?:RWY|TWY|APCH|APPROACH)[^,;.]{0,18}/g,' ')
      .replace(/\b(?:N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST)\s+OF\s+(?:RWY|TWY)\s+[A-Z0-9\/]+/g,' ')  // "<dir> OF TWY A7" = boundary landmark, not a closure
      .replace(/\bAT\s+(?:RWY|TWY)\s+[A-Z0-9\/]+/g,' ');                                                  // "AT TWY B" = location, not a closure
    var wRe=/\bTWY\s+([A-Z]\d?)((?:\s*,\s*[A-Z]\d?(?![A-Z0-9])){0,12})/g;
    while(m=wRe.exec(cleaned)){
      var ids=[m[1]]; if(m[2]){ (m[2].match(/[A-Z]\d?/g)||[]).forEach(function(x){ids.push(x);}); }
      ids.forEach(function(id){ out.push({twy:id,from:null,to:null}); });
    }
    return out;
  }
  function closedTwyIds(text){ var s={}; closedTwySegs(text).forEach(function(c){ s[c.twy]=1; }); return Object.keys(s); }

  function normRwy(s){ return String(s||'').toUpperCase().replace(/\d+/g,function(d){return d.length<2?'0'+d:d;}); }
  function oppEnd(id){ var side=(id.match(/[LRC]/)||[''])[0], n=parseInt(id,10)||0, o=((n+18-1)%36)+1;
    var os=side==='L'?'R':side==='R'?'L':side; return (o<10?'0':'')+o+os; }
  // Runway closures: closed / partial (portion) / displaced (threshold).
  function closedRwys(text){
    var t=(text||'').toUpperCase();
    if(!/\bCLSD\b/.test(t) && !/DISPLAC/.test(t)) return [];
    if(t.length>420) t=t.slice(0,420);
    var cleaned=t.replace(/\bBTN\b[^,;.]{0,40}\bAND\b\s*(?:RWY|TWY|APCH|APPROACH)[^,;.]{0,18}/g,' ')
      .replace(/\bAND\s+RWY\s+\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?/g,' ')                                              // "...AND RWY 07L/25R" = boundary of a TWY closure
      .replace(/\b(?:N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST)\s+OF\s+RWY\s+\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?/g,' '); // "<dir> OF RWY x" = boundary
    var out=[], m, rid='(\\d{1,2}[LRC]?(?:/\\d{1,2}[LRC]?)?)';
    // displaced threshold: "RWY <end> THR DISPLACED ... <n>FT"
    var rdt=new RegExp('\\bRWY\\s+(\\d{1,2}[LRC]?)\\s+THR\\s+DISPLACED[^.]{0,30}?(\\d{2,5})\\s?FT','g');
    while(m=rdt.exec(t)){ out.push({rwy:m[1],kind:'displaced',end:m[1],dist:parseInt(m[2],10),dir:'',detail:'THR displaced '+m[2]+' ft'}); }
    // partial closure: "RWY <id> <..NNNFT..> CLSD" — extent from a compass end ("SW 3451FT") or a runway end ("FST/LAST 1000FT").
    var rp=new RegExp('\\bRWY\\s+'+rid+'\\s+([A-Z0-9 ]{0,18}?(\\d{2,5})\\s?FT)\\s+CLSD','g');
    while(m=rp.exec(cleaned)){ var q=m[2], dm=q.match(/\b(NE|NW|SE|SW|N|S|E|W)\b/), single=m[1].indexOf('/')<0, endRef='';
      if(!dm && single){ if(/\b(FST|FIRST)\b/.test(q)) endRef=m[1]; else if(/\bLAST\b/.test(q)) endRef=oppEnd(m[1]); }
      out.push({rwy:m[1],kind:'partial',detail:q.replace(/FT/,' FT').replace(/\s+/g,' ').trim(),dist:parseInt(m[3],10),dir:dm?dm[1]:'',end:endRef,taxiExc:false}); }
    // full / exception closure: "RWY <id> CLSD [EXC TAX... | EXC XNG]"  (XNG = crossing permitted)
    var rf=new RegExp('\\bRWY\\s+'+rid+'\\s+CLSD\\b(?:\\s+EXC\\s+(TAX\\w*|XNG))?','g');
    while(m=rf.exec(cleaned)){ var e=m[2]||''; out.push({rwy:m[1],kind:'closed',detail:'',dist:0,dir:'',end:'',taxiExc:/TAX/.test(e),xngExc:/XNG/.test(e)}); }
    return out;
  }
  // Recurring schedule in a NOTAM's E-line: day-of-week set and/or DLY. Null => continuous (no schedule).
  function notamSched(text){
    var t=(text||'').toUpperCase();
    var map={SUN:0,MON:1,TUE:2,WED:3,THU:4,FRI:5,SAT:6}, days=[];
    (t.match(/\b(MON|TUE|WED|THU|FRI|SAT|SUN)\b/g)||[]).forEach(function(d){ if(days.indexOf(map[d])<0) days.push(map[d]); });
    if(days.length) return {days:days};
    if(/\b(DLY|DAILY)\b/.test(t)) return {daily:true};
    return null;
  }
  function schedActive(sched, nowDow){ if(!sched) return true; if(sched.daily) return true; return sched.days.indexOf(nowDow)>=0; }
  var DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // ===== Geometry ============================================================
  function ftBetween(a,b){ var R=20902231.0, d1=(b[0]-a[0])*Math.PI/180, d2=(b[1]-a[1])*Math.PI/180;
    var s=Math.sin(d1/2)*Math.sin(d1/2)+Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(d2/2)*Math.sin(d2/2);
    return 2*R*Math.asin(Math.min(1,Math.sqrt(s))); }
  function polyLenFt(c){ var t=0; for(var i=1;i<c.length;i++) t+=ftBetween(c[i-1],c[i]); return t; }
  function refNorm(r){ return String(r||'').toUpperCase().replace(/\d+/g,function(d){return d.length<2?'0'+d:d;}); }
  // OSM ways (latlon arrays) whose ref matches a taxiway id.
  function twWays(geo,id){ id=id.toUpperCase(); var out=[]; (geo.taxiways||[]).forEach(function(w){ if((w.ref||'').toUpperCase()===id && w.c && w.c.length>1) out.push(w.c); }); return out; }
  // OSM runway ways matching a full id ("01L/19R") or a single end ("01L","19").
  function rwWays(geo,idOrEnd){
    var q=refNorm(idOrEnd), qEnds=q.split('/'); var out=[];
    (geo.runways||[]).forEach(function(w){ var r=refNorm(w.ref), ends=r.split('/'), hit=(r===q);
      if(!hit) qEnds.forEach(function(e){
        if(/[LRC]/.test(e)){ if(ends.indexOf(e)>=0) hit=true; }                                   // side specified -> exact end match
        else { var en=e.replace(/[LRC]/,''); if(ends.some(function(x){return x.replace(/[LRC]/,'')===en;})) hit=true; } // no side -> numeric match
      });
      if(hit && w.c && w.c.length>1) out.push(w.c);
    });
    return out;
  }
  function segList(ways){ var s=[]; ways.forEach(function(p){ for(var i=0;i<p.length-1;i++) s.push([p[i],p[i+1]]); }); return s; }
  // Merge multiple ways into one ordered polyline by connecting shared endpoints.
  function mergeWays(ways){
    if(!ways.length) return []; ways=ways.map(function(w){return w.slice();});
    var chain=ways.shift(), tolFt=26, changed=true;
    while(changed && ways.length){ changed=false;
      for(var k=0;k<ways.length;k++){ var w=ways[k];
        if(ftBetween(chain[chain.length-1],w[0])<tolFt){ chain=chain.concat(w.slice(1)); ways.splice(k,1); changed=true; break; }
        if(ftBetween(chain[chain.length-1],w[w.length-1])<tolFt){ chain=chain.concat(w.slice().reverse().slice(1)); ways.splice(k,1); changed=true; break; }
        if(ftBetween(chain[0],w[w.length-1])<tolFt){ chain=w.slice(0,-1).concat(chain); ways.splice(k,1); changed=true; break; }
        if(ftBetween(chain[0],w[0])<tolFt){ chain=w.slice().reverse().slice(0,-1).concat(chain); ways.splice(k,1); changed=true; break; }
      }
    }
    return chain;
  }
  function segInter(p1,p2,p3,p4){ // latlon; small-area planar intersection
    var d1x=p2[1]-p1[1], d1y=p2[0]-p1[0], d2x=p4[1]-p3[1], d2y=p4[0]-p3[0];
    var den=d1x*d2y-d1y*d2x; if(Math.abs(den)<1e-12) return null;
    var t=((p3[1]-p1[1])*d2y-(p3[0]-p1[0])*d2x)/den;
    var u=((p3[1]-p1[1])*d1y-(p3[0]-p1[0])*d1x)/den;
    if(t>=0&&t<=1&&u>=0&&u<=1) return [p1[0]+d1y*t, p1[1]+d1x*t];
    return null;
  }
  function projPtSeg(P,A,B){ var dx=B[1]-A[1], dy=B[0]-A[0], L2=dx*dx+dy*dy;
    var t=L2?Math.max(0,Math.min(1,((P[1]-A[1])*dx+(P[0]-A[0])*dy)/L2)):0;
    var Q=[A[0]+dy*t,A[1]+dx*t]; return {d:ftBetween(P,Q),Q:Q}; }
  // Arclength (ft) along subject S of its crossing/closest-approach to boundary segments.
  function crossingArc(S,Bsegs){
    var arc=0,i,j;
    for(i=0;i<S.length-1;i++){ var A=S[i],B=S[i+1];
      for(j=0;j<Bsegs.length;j++){ var X=segInter(A,B,Bsegs[j][0],Bsegs[j][1]); if(X) return arc+ftBetween(A,X); }
      arc+=ftBetween(A,B);
    }
    // fallback: closest approach to boundary vertices
    var best=1e18, bestArc=0; arc=0; var Bpts=[]; Bsegs.forEach(function(s){Bpts.push(s[0],s[1]);});
    for(i=0;i<S.length-1;i++){ var A2=S[i],B2=S[i+1];
      for(j=0;j<Bpts.length;j++){ var r=projPtSeg(Bpts[j],A2,B2); if(r.d<best){ best=r.d; bestArc=arc+ftBetween(A2,r.Q); } }
      arc+=ftBetween(A2,B2);
    }
    return bestArc;
  }
  // Sub-polyline of S between two arclengths.
  function subPoly(S,lo,hi){ var out=[],arc=0; if(hi<lo){var x=lo;lo=hi;hi=x;}
    for(var i=0;i<S.length-1;i++){ var A=S[i],B=S[i+1],L=ftBetween(A,B),s0=arc,s1=arc+L;
      if(s1>=lo&&s0<=hi&&L>0){ var ta=Math.max(0,(lo-s0)/L), tb=Math.min(1,(hi-s0)/L);
        var Pa=[A[0]+(B[0]-A[0])*ta,A[1]+(B[1]-A[1])*ta], Pb=[A[0]+(B[0]-A[0])*tb,A[1]+(B[1]-A[1])*tb];
        if(!out.length) out.push(Pa); out.push(Pb); }
      arc+=L;
    }
    return out;
  }
  function pickEndIdx(c,dir){ var a=c[0], b=c[c.length-1];
    function sc(p){ var s=0; if(/N/.test(dir))s+=p[0]; if(/S/.test(dir))s-=p[0]; if(/E/.test(dir))s+=p[1]; if(/W/.test(dir))s-=p[1]; return s; }
    return sc(a)>=sc(b)?0:c.length-1; }
  function walkFromEnd(c,endIdx,distFt){ var pts=endIdx===0?c.slice():c.slice().reverse(), out=[pts[0]], acc=0;
    for(var i=1;i<pts.length;i++){ var seg=ftBetween(pts[i-1],pts[i]);
      if(acc+seg>=distFt){ var t=(distFt-acc)/seg; out.push([pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t, pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t]); return out; }
      acc+=seg; out.push(pts[i]); } return out; }
  // Endpoint index whose position matches a runway END number (threshold opposite the heading).
  function pickEndByNum(c,num){
    var heading=((parseInt(num,10)||0)%36)*10, target=(heading+180)%360;
    var cx=0,cy=0; c.forEach(function(p){cx+=p[0];cy+=p[1];}); cx/=c.length; cy/=c.length;
    function brg(p){ var dLon=(p[1]-cy)*Math.PI/180, la=p[0]*Math.PI/180, la0=cx*Math.PI/180;
      var y=Math.sin(dLon)*Math.cos(la), x=Math.cos(la0)*Math.sin(la)-Math.sin(la0)*Math.cos(la)*Math.cos(dLon);
      return (Math.atan2(y,x)*180/Math.PI+360)%360; }
    function diff(a,b){ var dd=Math.abs(a-b)%360; return dd>180?360-dd:dd; }
    return diff(brg(c[0]),target)<=diff(brg(c[c.length-1]),target)?0:c.length-1;
  }
  // Closed portion for a partial runway closure {dist,dir}; null if not placeable.
  function closedPortion(coords,rc){
    if(!coords||coords.length<2||!rc||!rc.dist) return null;
    if(rc.dist>=polyLenFt(coords)*0.98) return null;
    var idx = rc.dir ? pickEndIdx(coords,rc.dir) : (rc.end?pickEndByNum(coords,rc.end):0);
    var seg=walkFromEnd(coords,idx,rc.dist); return seg.length>1?seg:null;
  }
  // Clipped segment of a closed taxiway between two boundary features; null on failure.
  function taxiwaySegment(geo,clause){
    var S=mergeWays(twWays(geo,clause.twy)); if(S.length<2) return null;
    function bsegs(ref){ if(!ref) return null; return ref.type==='rwy'?segList(rwWays(geo,ref.id)):segList(twWays(geo,ref.id)); }
    var b1=bsegs(clause.from), b2=bsegs(clause.to);
    if(!b1||!b1.length||!b2||!b2.length) return null;
    var a1=crossingArc(S,b1), a2=crossingArc(S,b2);
    var seg=subPoly(S,a1,a2); return seg.length>1?seg:null;
  }

  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

  // ===== Modal ===============================================================
  function open(icao){
    var data=(w.__pwdiag||{})[icao]; if(!data){ alert('No diagram data for '+icao); return; }
    var items=data.items||[];
    var NOWDOW=(new Date()).getUTCDay();
    // Absorb FNS/SWIM schedule loss: group NOTAM instances by identity; a closure is scheduled if ANY sibling carries a schedule.
    // Group by validity window (start|end): FNS drops the schedule text but shares start/end with its scheduled SWIM twin,
    // so grouping on start|end lets the schedule from the twin cover the schedule-less copy.
    function idKey(n){ return (n.start||n.end) ? ((n.start||'')+'|'+(n.end||'')) : ('n:'+(n.number||n.text||'')); }
    // ----- taxiways: clause + whether its NOTAM is active today -----
    var twClauses={}, twInactive={};
    items.forEach(function(n){ var segs=closedTwySegs(n.text); if(!segs.length) return;
      var act=schedActive(notamSched(n.text), NOWDOW);
      segs.forEach(function(c){ if(act){ (twClauses[c.twy]=twClauses[c.twy]||[]).push(c); } else { twInactive[c.twy]=1; } });
    });
    var cl=Object.keys(twClauses).sort();
    var twSchedOnly=Object.keys(twInactive).filter(function(id){return !twClauses[id];}).sort();
    // ----- runways: aggregate, group by identity for schedule, keep only active-today closures -----
    var rInst={}; items.forEach(function(n){ closedRwys(n.text).forEach(function(r){ var k=normRwy(r.rwy); (rInst[k]=rInst[k]||[]).push({r:r,n:n}); }); });
    var closedR={}, rSched={};
    Object.keys(rInst).forEach(function(key){
      var groups={}; rInst[key].forEach(function(x){ var g=idKey(x.n); (groups[g]=groups[g]||{texts:[],rs:[]}); groups[g].texts.push(x.n.text||''); groups[g].rs.push(x.r); });
      var active=false, schedDays={};
      Object.keys(groups).forEach(function(g){ var s=notamSched(groups[g].texts.join(' '));
        if(schedActive(s,NOWDOW)) active=true; else if(s&&s.days) s.days.forEach(function(d){schedDays[d]=1;}); });
      if(!active){ rSched[key]=Object.keys(schedDays).map(function(d){return DOW[d];}).join('/'); return; } // scheduled but not today
      var p={kind:null,detail:'',taxiExc:false,xngExc:false,dist:0,dir:'',end:''};
      rInst[key].forEach(function(x){ var r=x.r;
        if(r.kind==='closed'){ p.kind='closed'; if(r.taxiExc)p.taxiExc=true; if(r.xngExc)p.xngExc=true; }
        else if(r.kind==='partial'){ if(p.kind!=='closed'){ p.kind='partial'; p.detail=r.detail; p.dist=r.dist; p.dir=r.dir; } }
        else if(r.kind==='displaced'){ if(!p.kind){ p.kind='displaced'; p.detail=r.detail; p.dist=r.dist; p.end=r.end; } }
      });
      closedR[key]=p;
    });
    var rk=Object.keys(closedR).sort();
    function rwLabel(k){ var r=closedR[k];
      if(r.kind==='partial') return k+' — '+esc(r.detail)+' closed';
      if(r.kind==='displaced') return k+' — '+esc(r.detail);
      var exc=r.taxiExc?' (taxi only)':r.xngExc?' (crossing only)':'';
      return k+' — closed'+exc; }
    var rwStr=rk.map(rwLabel).join('; ');
    // scheduled-but-not-active note (runways + taxiways)
    var schedBits=[]; Object.keys(rSched).sort().forEach(function(k){ schedBits.push('RWY '+k+(rSched[k]?' ('+rSched[k]+')':'')); });
    twSchedOnly.forEach(function(id){ schedBits.push('TWY '+id); });
    var schedStr=schedBits.join(', ');

    var ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;background:rgba(11,22,34,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
    var panel=document.createElement('div');
    panel.style.cssText='background:#fff;border-radius:12px;width:min(1000px,96vw);height:min(760px,94vh);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.4)';
    panel.innerHTML=
      '<div style="padding:10px 14px;border-bottom:1px solid #e5e9ee;display:flex;align-items:center;gap:10px;font:600 14px sans-serif;color:#1b2733">'
      +'<span>'+esc(icao)+' — Airport Diagram <span id="pwd-src" style="color:#8a97a5;font-weight:500">· loading…</span></span>'
      +'<button id="pwd-toggle" style="display:none;margin-left:auto;font-size:12px;background:#eef2f5;border:1px solid #d3dbe3;border-radius:6px;padding:4px 10px;cursor:pointer;color:#2f6fed;font-weight:600"></button>'
      +'<a id="pwd-faa" href="https://skyvector.com/airport/'+encodeURIComponent(icao)+'" target="_blank" rel="noopener" style="margin-left:auto;font-size:12px;color:#2f6fed;text-decoration:none">Official FAA diagram ↗</a>'
      +'<button id="pwd-x" style="border:0;background:#eef2f5;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:16px;color:#33414f">✕</button></div>'
      +'<div id="pwd-map" style="flex:1;background:#f4f6f8;position:relative"></div>'
      +'<div id="pwd-foot" style="padding:8px 14px;border-top:1px solid #e5e9ee;font:12px sans-serif;color:#33414f">'
      +(rk.length?'<b>Closed runways:</b> <span style="color:#c01722;font-weight:700">'+rwStr+'</span> &nbsp;·&nbsp; ':'')
      +'<b>Closed taxiways:</b> <span style="color:#c01722;font-weight:700">'+(cl.length?cl.join(', '):'none active')+'</span> '
      +(schedStr?'<br><b style="color:#8a6d1b">Scheduled (not active '+DOW[NOWDOW]+'):</b> <span style="color:#8a6d1b;font-weight:600">'+esc(schedStr)+'</span> ':'')
      +'<span style="color:#8a97a5">· current-day closures only; scheduled/recurring closures listed separately; crossing/taxi exceptions shown dashed; verify against the official diagram &amp; NOTAMs</span></div>';
    ov.appendChild(panel); document.body.appendChild(ov);
    function close(){ if(ov.parentNode) ov.parentNode.removeChild(ov); }
    panel.querySelector('#pwd-x').onclick=close;
    ov.addEventListener('click',function(e){ if(e.target===ov) close(); });

    var CB='&v=2';   // stable cache key (was a per-request timestamp that forced a live Overpass hit every open -> rate limits)
    var RED='#d61f26', AMBER='#e8871e';
    var mapHost=panel.querySelector('#pwd-map'), foot=panel.querySelector('#pwd-foot'), srcLbl=panel.querySelector('#pwd-src'), curMap=null;
    var faaUrl=null, curView=null, toggleBtn=panel.querySelector('#pwd-toggle');
    function updateToggle(v){ if(!toggleBtn) return; if(!faaUrl){ toggleBtn.style.display='none'; return; } toggleBtn.style.display=''; toggleBtn.textContent=(v==='faa')?'▤ Show NOTAMs on map':'■ FAA chart'; }
    if(toggleBtn) toggleBtn.onclick=function(){ if(curView==='faa') renderOsm(); else if(faaUrl) renderFaa(faaUrl); };
    if(!document.getElementById('pw-spin-style')){ var st=document.createElement('style'); st.id='pw-spin-style'; st.textContent='@keyframes pwspin{to{transform:rotate(360deg)}}'; document.head.appendChild(st); }
    function cleanup(){ if(curMap){ try{ curMap.remove(); }catch(e){} curMap=null; } try{ if(mapHost._leaflet_id) delete mapHost._leaflet_id; }catch(e){} mapHost.innerHTML=''; }
    function showLoading(msg){ mapHost.innerHTML='<div id="pwd-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;color:#5a6773;font:13px sans-serif;background:#f4f6f8;z-index:5"><span style="width:15px;height:15px;border:2px solid #c9d2db;border-top-color:#2f6fed;border-radius:50%;display:inline-block;animation:pwspin .8s linear infinite"></span> '+msg+'</div>'; }
    function stopLoading(){ var e=document.getElementById('pwd-loading'); if(e&&e.parentNode) e.parentNode.removeChild(e); }
    function setSrc(t){ if(srcLbl) srcLbl.textContent=t; }
    // Prominent closures panel, drawn over whichever diagram source renders (satisfies "closures on the diagram").
    function closuresPanel(){
      if(document.getElementById('pwd-clos')) return;
      var d=document.createElement('div'); d.id='pwd-clos';
      d.style.cssText='position:absolute;left:10px;top:10px;z-index:1200;max-width:min(360px,66%);background:rgba(255,255,255,.96);border:1px solid #e0b6b6;border-left:5px solid '+RED+';border-radius:9px;padding:9px 12px;font:600 13px/1.45 sans-serif;color:#26313c;box-shadow:0 2px 12px rgba(0,0,0,.22)';
      var h='<div style="font-weight:800;margin-bottom:3px">NOTAM closures — today</div>';
      if(rk.length) h+='<div><span style="color:'+RED+';font-weight:800">RWY:</span> '+esc(rwStr)+'</div>';
      h+='<div><span style="color:'+RED+';font-weight:800">TWY:</span> '+(cl.length?esc(cl.join(', ')):'<span style="color:#2f7a45">none active</span>')+'</div>';
      if(schedStr) h+='<div style="color:#8a6d1b;margin-top:3px"><b>Scheduled (not active '+DOW[NOWDOW]+'):</b> '+esc(schedStr)+'</div>';
      d.innerHTML=h; mapHost.appendChild(d);
    }
    function linkFallback(msg){ cleanup();
      // If we have the official FAA diagram in hand, offer it directly (one click, in-app) instead of
      // punting to an external site. Only fields with no published FAA diagram (e.g. KDIJ) fall through
      // to the external airport-info link.
      if(faaUrl){
        mapHost.innerHTML='<div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;color:#5a6773;font:13px sans-serif;padding:24px"><div>OSM base map is unavailable right now.</div><button id="pwd-back-faa" style="background:#2f6fed;color:#fff;padding:9px 16px;border:0;border-radius:8px;cursor:pointer;font-weight:600">■ Show FAA airport diagram</button></div>';
        closuresPanel();
        var bf=document.getElementById('pwd-back-faa'); if(bf) bf.onclick=function(){ renderFaa(faaUrl); };
        return;
      }
      mapHost.innerHTML='<div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;color:#5a6773;font:13px sans-serif;padding:24px"><div>'+msg+'</div><a href="https://skyvector.com/airport/'+encodeURIComponent(icao)+'" target="_blank" rel="noopener" style="background:#2f6fed;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open official airport diagram ↗</a></div>';
      closuresPanel();
    }
    // ----- Preferred: official FAA diagram, rendered clean via PDF.js (no browser PDF chrome) -----
    function loadPdfJs(cb){
      if(w.pdfjsLib) return cb(w.pdfjsLib);
      var s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
      s.onload=function(){ try{ if(w.pdfjsLib) w.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'; }catch(e){} cb(w.pdfjsLib||null); };
      s.onerror=function(){ cb(null); };
      document.head.appendChild(s);
    }
    function renderFaa(pdfUrl){
      cleanup(); showLoading('Loading official FAA airport diagram…'); setSrc('· FAA chart'); curView='faa'; updateToggle('faa');
      loadPdfJs(function(lib){
        if(!lib) return renderOsm();
        fetch('/.netlify/functions/chartpdf?u='+encodeURIComponent(pdfUrl)+CB).then(function(r){ if(!r.ok) throw 0; return r.arrayBuffer(); })
          .then(function(buf){ return lib.getDocument({data:new Uint8Array(buf)}).promise; })
          .then(function(pdf){ return pdf.getPage(1); })
          .then(function(page){
            var v1=page.getViewport({scale:1}), scale=Math.min(3.2,Math.max(1.6,2400/Math.max(v1.width,v1.height)));
            var vp=page.getViewport({scale:scale}), canvas=document.createElement('canvas');
            canvas.width=Math.round(vp.width); canvas.height=Math.round(vp.height);
            return page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise.then(function(){ return canvas; });
          })
          .then(function(canvas){
            cleanup();
            var m2=L.map(mapHost,{crs:L.CRS.Simple,zoomControl:false,attributionControl:false,minZoom:-5,maxZoom:4,zoomSnap:.25}); curMap=m2;
            L.control.zoom({position:'topright'}).addTo(m2);
            var bounds=[[0,0],[canvas.height,canvas.width]];
            L.imageOverlay(canvas.toDataURL('image/png'),bounds).addTo(m2);
            m2.fitBounds(bounds); setTimeout(function(){ try{ m2.invalidateSize(); m2.fitBounds(bounds); }catch(e){} },60);
            setSrc('· FAA chart · closures listed'); closuresPanel();
          })
          .catch(function(){ renderOsm(); });
      });
    }
    // ----- Fallback: OSM geometry, closures pinpointed in red (used for no-FAA fields, or if the chart fails) -----
    function renderOsm(){
      cleanup(); showLoading('Building airport diagram (OSM)…'); setSrc('· OSM · closures highlighted'); curView='osm'; updateToggle('osm');
      var map=L.map(mapHost,{zoomControl:false,attributionControl:false}); curMap=map;
      L.control.zoom({position:'topright'}).addTo(map);
      map.setView([data.lat,data.lon],14);
      setTimeout(function(){ try{ map.invalidateSize(); }catch(e){} },80);
      var g=L.layerGroup().addTo(map);
      var lbl=function(txt,c){ return L.divIcon({className:'',html:'<span style="font:'+(c.f)+';color:'+c.color+';text-shadow:0 0 3px #fff,0 0 3px #fff">'+esc(txt)+'</span>',iconSize:c.sz}); };
      var legEl=document.createElement('div');
      legEl.style.cssText='position:absolute;left:10px;bottom:10px;z-index:1200;background:rgba(255,255,255,.95);border:1px solid #cdd6df;border-radius:9px;padding:9px 13px;font:600 14px/1.35 sans-serif;color:#26313c;box-shadow:0 2px 10px rgba(0,0,0,.22)';
      function legRow(color,dash,label){ return '<div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="display:inline-block;width:26px;height:0;border-top:5px '+(dash?'dashed':'solid')+' '+color+'"></span><span>'+label+'</span></div>'; }
      legEl.innerHTML='<div style="font-weight:800;font-size:14px;margin-bottom:5px">Closures</div>'+legRow(RED,false,'Closed (RWY / TWY)')+legRow(AMBER,false,'Closed portion / displaced')+legRow(RED,true,'Taxi / crossing only');
      mapHost.appendChild(legEl);
      fetch('/.netlify/functions/airportgeo?lat='+data.lat+'&lon='+data.lon+'&icao='+encodeURIComponent(icao)+CB).then(function(r){return r.json();}).then(function(geo){
        if(!geo || geo.error || (!(geo.taxiways||[]).length && !(geo.runways||[]).length)){ linkFallback('Airport diagram is unavailable right now (OSM &amp; FAA chart service).'); return; }
        var bounds=[], notLocated=[];
        (geo.aprons||[]).forEach(function(a){ if(a.c&&a.c.length>2) L.polygon(a.c,{color:'#d7dee6',weight:1,fillColor:'#e7ecf1',fillOpacity:.7,interactive:false}).addTo(g); });
        (geo.taxiways||[]).forEach(function(tw){ if(!tw.c||tw.c.length<2)return; bounds=bounds.concat(tw.c);
          L.polyline(tw.c,{color:'#9aa7b4',weight:2,opacity:.9,interactive:false}).addTo(g);
          if(tw.ref){ var mpt=tw.c[Math.floor(tw.c.length/2)]; L.marker(mpt,{interactive:false,icon:lbl(tw.ref,{f:'700 10px sans-serif',color:'#3a4756',sz:[18,12]})}).addTo(g); }
        });
        cl.forEach(function(id){
          var clauses=twClauses[id], drewSomething=false, whole=clauses.some(function(c){return !c.from||!c.to;});
          var S=mergeWays(twWays(geo,id));
          if(!whole){ clauses.forEach(function(c){ var seg=taxiwaySegment(geo,c);
            if(seg){ L.polyline(seg,{color:RED,weight:6,opacity:.97,interactive:false}).addTo(g);
                     L.polyline(seg,{color:'#fff',weight:1.5,opacity:.9,dashArray:'2 5',interactive:false}).addTo(g); drewSomething=true; } }); }
          if((whole || !drewSomething) && S.length>1){ L.polyline(S,{color:RED,weight:5,opacity:.95,interactive:false}).addTo(g);
            L.polyline(S,{color:'#fff',weight:1.4,opacity:.9,dashArray:'2 5',interactive:false}).addTo(g); drewSomething=true; }
          if(!drewSomething) notLocated.push('TWY '+id);
        });
        (geo.runways||[]).forEach(function(rw){ if(!rw.c||rw.c.length<2)return; bounds=bounds.concat(rw.c);
          var ref=normRwy(rw.ref), rc=closedR[ref] || (function(){ for(var k in closedR){ if(k.split('/').some(function(e){ return ref.split('/').indexOf(e)>=0; })) return closedR[k]; } return null; })();
          L.polyline(rw.c,{color:'#33414f',weight:8,opacity:.95,interactive:false}).addTo(g);
          if(rc){
            if(rc.kind==='partial' || rc.kind==='displaced'){
              var portion=closedPortion(rw.c, rc);
              if(portion){ L.polyline(portion,{color:AMBER,weight:9,opacity:.97,interactive:false}).addTo(g);
                L.polyline(portion,{color:'#fff',weight:1.6,opacity:.9,dashArray:'3 7',interactive:false}).addTo(g);
                if(rc.kind==='displaced'){ var thr=portion[portion.length-1]; L.circleMarker(thr,{radius:5,color:'#fff',weight:2,fillColor:AMBER,fillOpacity:1,interactive:false}).addTo(g); }
              } else { L.polyline(rw.c,{color:AMBER,weight:9,opacity:.9,interactive:false}).addTo(g); }
            } else if(rc.taxiExc || rc.xngExc){ L.polyline(rw.c,{color:RED,weight:6,opacity:.95,dashArray:'14 10',interactive:false}).addTo(g); }
            else { L.polyline(rw.c,{color:RED,weight:9,opacity:.96,interactive:false}).addTo(g);
              L.polyline(rw.c,{color:'#fff',weight:1.6,opacity:.9,dashArray:'3 7',interactive:false}).addTo(g); }
          }
          if(rw.ref) L.marker(rw.c[0],{interactive:false,icon:lbl(rw.ref,{f:'800 11px sans-serif',color:(rc?'#7a1016':'#0b1622'),sz:[46,14]})}).addTo(g);
        });
        if(bounds.length) map.fitBounds(bounds,{padding:[14,14]});
        stopLoading(); closuresPanel();
        if(notLocated.length) foot.insertAdjacentHTML('beforeend',' <span style="color:#8a97a5">(not located on OSM map: '+esc(notLocated.join(', '))+')</span>');
      }).catch(function(){ linkFallback('Airport diagram is unavailable right now.'); });
    }
    // Kick off: FAA preferred; OSM fallback when there's no FAA diagram (e.g. KDIJ) or the chart fails.
    showLoading('Loading airport diagram…');
    fetch('/.netlify/functions/airportchart?icao='+encodeURIComponent(icao)+CB).then(function(r){return r.json();}).then(function(ch){
      var a=panel.querySelector('#pwd-faa');
      if(ch && ch.diagram && ch.diagram.url){ faaUrl=ch.diagram.url; if(a) a.href='/.netlify/functions/chartpdf?u='+encodeURIComponent(faaUrl); renderFaa(faaUrl); }
      else renderOsm();
    }).catch(function(){ renderOsm(); });
  }
  w.PWDiagram = { open: open, _closedTwySegs: closedTwySegs, _closedTwyIds: closedTwyIds, _closedRwys: closedRwys,
                  _taxiwaySegment: taxiwaySegment, _closedPortion: closedPortion, _mergeWays: mergeWays, _polyLenFt: polyLenFt, _rwWays: rwWays, _twWays: twWays,
                  _notamSched: notamSched, _schedActive: schedActive };
})(window);
