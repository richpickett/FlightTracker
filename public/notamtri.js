/* Personal Wings — NOTAM triage + ForeFlight-style category/source filtering.
   Layers on top of the briefing's existing notamCat()/notamPlain()/nesc()/fmtNz() globals.
   PWNotam.triage(list, refLatLon) -> { items, total, counts:{cat:{}, local, regional} }
     each item tagged: _cat (category), _local (bool), _c/_fac/_dups (as before)
   PWNotam.filter = { cats:{...on/off...}, src:{local,regional} }   // live filter state
   PWNotam.renderBar(barEl, aggCounts, onToggle)                     // the filter chip bar
   PWNotam.renderList(blk, p, arr, mode, rawN)                       // mode: 'off' | 'plain'
   PWNotam.applyFilter(arr) -> arr                                   // for the AI-summary path
*/
(function (w) {
  function esc(s){ return (w.nesc ? w.nesc(s) : String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];})); }
  function plain(t){ return w.notamPlain ? w.notamPlain(t) : String(t); }
  function cat(t){ return w.notamCat ? w.notamCat(t) : {label:'OTHER',color:'#6b7280',pri:4}; }
  function fmt(s){ return w.fmtNz ? w.fmtNz(s) : (s||''); }
  function diag(id){ return ' · <a class="inline" href="https://skyvector.com/airport/'+encodeURIComponent(id)+'" target="_blank" rel="noopener">✈ SkyVector / Airport Charts ↗</a>'; }
  function diagLinks(p, arr){
    w.__pwdiag = w.__pwdiag || {}; w.__pwdiag[p.id] = { lat:p.la, lon:p.lo, items:arr };
    var hasClose = arr.some(function(n){ var u=(n.text||'').toUpperCase(); return /\b(TWY|RWY)\b/.test(u) && /\bCLSD\b/.test(u); });
    // Always offer the airport diagram / satellite view — even with no RWY/TWY closures. Label reflects whether closures exist.
    var diagram = w.PWDiagram ? ' · <a class="inline pw-lock" href="#" onclick="try{PWDiagram.open(\''+p.id+'\')}catch(e){};return false;">'+(hasClose?'⚠ ':'')+'🛰 FAA/SAT Airport Diagram</a>' : '';
    return diag(p.id) + diagram;
  }

  // Dedup signature — collapses FNS+SWIM double-listings and reissues (identical/near-identical text).
  function sig(t){
    return String(t||'').toUpperCase().replace(/\s+/g,' ')
      .replace(/\d{6,}/g,' ')
      .replace(/\b(EST|EDT|UTC|ESTIMATED|PERM)\b/g,' ')
      .replace(/\b(SID|STAR|ODP|IAP|VFP|NAV|SVC|DP)\b/g,' ')
      .replace(/\d{4}-[A-Z]{3}-\d{3,6}-OE/g,' ')
      .replace(/[^A-Z0-9/ ]/g,' ').replace(/\s+/g,' ').trim();
  }
  function fac(t){
    t=String(t||'').toUpperCase(); var m;
    if(m=t.match(/\bRWY\s?(\d{2}[LRC]?(?:\/\d{2}[LRC]?)?)/)) return 'RWY '+m[1];
    if(m=t.match(/\b((?:[A-Z]{2,}\s){1,3}(?:ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|\d{1,2}))\s+(?:DEPARTURE|ARRIVAL)/)) return m[1].trim();
    if(m=t.match(/\bTWY\s?([A-Z]{1,2}\d?)/)) return 'TWY '+m[1];
    return '';
  }
  function facRank(k){ if(!k) return '9'; if(k.indexOf('RWY ')===0) return '1'+k; if(k.indexOf('TWY ')===0) return '3'+k; return '2'+k; }

  function parseCoords(t){
    var re=/(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])\s*(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([EW])/g, o=[], m;
    while((m=re.exec(t))){ var la=(+m[1])+(+m[2])/60+(+m[3])/3600; if(m[4]==='S')la=-la;
      var lo=(+m[5])+(+m[6])/60+(+m[7])/3600; if(m[8]==='W')lo=-lo; o.push([la,lo]); }
    return o;
  }
  function distNM(a,b){ var R=3440.065,d=Math.PI/180, dA=(b[0]-a[0])*d, dO=(b[1]-a[1])*d;
    var s=Math.sin(dA/2)*Math.sin(dA/2)+Math.cos(a[0]*d)*Math.cos(b[0]*d)*Math.sin(dO/2)*Math.sin(dO/2);
    return 2*R*Math.asin(Math.min(1,Math.sqrt(s))); }
  var RADIUS_NM=50;   // Local vs Regional cutoff

  // ---- Geometry helpers (NMS GeoJSON coords are [lon,lat]) ----
  function geomShapes(g){
    var rings=[], pts=[];
    function addRings(coords){ for(var r=0;r<coords.length;r++){ var ring=coords[r], pr=[]; for(var i=0;i<ring.length;i++){ var q=ring[i]; if(q&&q.length>=2){ pr.push([q[1],q[0]]); pts.push([q[1],q[0]]); } } if(pr.length>=3) rings.push(pr); } }
    function walk(x){ if(!x) return;
      if(x.type==='GeometryCollection'&&x.geometries){ x.geometries.forEach(walk); return; }
      if(x.type==='Polygon'&&x.coordinates){ addRings(x.coordinates); return; }
      if(x.type==='MultiPolygon'&&x.coordinates){ x.coordinates.forEach(addRings); return; }
      if(x.type==='Point'&&x.coordinates){ var c=x.coordinates; if(c.length>=2) pts.push([c[1],c[0]]); return; }
      if((x.type==='LineString'||x.type==='MultiPoint')&&x.coordinates){ x.coordinates.forEach(function(c){ if(c&&c.length>=2) pts.push([c[1],c[0]]); }); return; }
    }
    walk(g); return { rings:rings, pts:pts };
  }
  function pip(pt, ring){ var inside=false, y=pt[0], x=pt[1];
    for(var i=0,j=ring.length-1;i<ring.length;j=i++){ var yi=ring[i][0], xi=ring[i][1], yj=ring[j][0], xj=ring[j][1];
      if(((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside; } return inside; }
  // Local = airport is inside the NOTAM area, or within RADIUS_NM of it, or the NOTAM carries no readable
  // location (field-attached items with no coords are treated Local). Otherwise Regional.
  function nearField(n, ref){
    if(!ref) return true;
    var sh=geomShapes(n.geometry);
    for(var r=0;r<sh.rings.length;r++){ if(pip(ref, sh.rings[r])) return true; }
    var pts=sh.pts.slice(), cs=parseCoords(n.text||'');
    for(var c=0;c<cs.length;c++) pts.push(cs[c]);
    if(!pts.length) return true;
    for(var i=0;i<pts.length;i++){ if(distNM(ref, pts[i])<=RADIUS_NM) return true; }
    return false;
  }

  // ---- ForeFlight-style category from the ICAO Q-code subject (chars 2-3 of QXXYY), text fallback for SkyLink ----
  //   Runway=MR · Taxiway=MX · TFR=RT · Obstacle=OB · Airport=M*/F*/L*/I*/N*/C* (field surface, lighting, ILS,
  //   navaids, comms) · Procedures=P* (approaches/SIDs/STARs/ODPs) · Airspace=A*/R*/W* (airways, restricted/
  //   prohibited/danger/UAS reservations, mil/laser warnings) · GPS=G* · everything else=Other.
  function categorize(n){
    var s=(n.subject || ((n.qCode||'').length>=3 ? (n.qCode||'').slice(1,3) : '') || '').toUpperCase();
    if(s){
      if(s==='MR') return 'Runway';
      if(s==='MX') return 'Taxiway';
      if(s==='RT') return 'TFR';
      if(s==='OB') return 'Obstacle';
      var c=s.charAt(0);
      if(c==='M'||c==='F'||c==='L'||c==='I'||c==='N'||c==='C') return 'Airport';
      if(c==='P') return 'Procedures';
      if(c==='A'||c==='R'||c==='W') return 'Airspace';
      if(c==='G') return 'GPS';
      return 'Other';
    }
    var t=(n.text||'').toUpperCase();
    if(/\bTFR\b|TEMPORARY FLIGHT RESTRICTION|\b91\.13[57]\b/.test(t)) return 'TFR';
    if(/\bTWY\b/.test(t)) return 'Taxiway';
    if(/\bRWY\b/.test(t)) return 'Runway';
    if(/\bOBST\b|\bCRANE\b|\bTOWER\b|\bANTENNA\b/.test(t)) return 'Obstacle';
    if(/\bIAP\b|\bSID\b|\bSTAR\b|\bODP\b|APPROACH|DEPARTURE PROCEDURE|\bMINIMUMS?\b/.test(t)) return 'Procedures';
    if(/\bGPS\b|\bGNSS\b|\bWAAS\b/.test(t)) return 'GPS';
    if(/AIRSPACE|RESTRICTED AREA|\bMOA\b|PROHIBITED AREA|\bUAS\b/.test(t)) return 'Airspace';
    return 'Other';
  }

  // A NOTAMC cancellation carries the cancelled closure's text ("RWY x CLSD CANCELED") — drop it entirely.
  function isCancel(n){ var t=(n.text||'').toUpperCase();
    return /\bNOTAMC\b/.test(t) || /\bCANCELL?ED\b/.test(t) || /\bCNL\b/.test(t) || (n.condition||'').toUpperCase()==='XX'; }
  // A "hard stop" is an actual RWY/TWY closure — not a PAPI/lighting/nav U-S advisory. Only these belong in
  // the Critical group. Uses the mirror's closed flag when present, else a closure-text check.
  function isHardStop(n){
    if(n.closed===true) return true;
    var t=(n.text||'').toUpperCase();
    return /\b(RWY|TWY)\b/.test(t) && /\bCLSD\b|\bCLOSED\b/.test(t);
  }
  // Time status of a NOTAM vs now + the planned arrival window [ETA−1h, ETA+2h].
  function timeStatus(n, etaMs, role){
    var s=n.start?Date.parse(n.start):null, e=n.end?Date.parse(n.end):null, now=Date.now();
    if(e!=null && e<now) return {label:'ended', col:'#9aa7b4', dim:true};
    if(etaMs!=null){ var ws=etaMs-3600000, we=etaMs+7200000;
      if((s==null||s<=we)&&(e==null||e>=ws)) return {label:'at '+(role||'ETA'), col:'#c0392b', dim:false}; }
    if(s!=null && s>now) return {label:'later', col:'#b7791f', dim:false};
    return {label:'active', col:'#2f7a45', dim:false};
  }
  // Category order + the on/off default (Airport, Runway, Taxiway, Procedures, TFR on; rest off).
  var CATS = ['Airport','Runway','Taxiway','Procedures','Airspace','Obstacle','TFR','GPS','Other'];
  var DEFAULT_ON = { Airport:1, Runway:1, Taxiway:1, Procedures:1, TFR:1 };

  function triage(list, ref){
    var byS={}, order=[];
    for(var i=0;i<list.length;i++){
      var n=list[i], t=(n.text||''); if(!t) continue;
      if(isCancel(n)) continue;                 // cancellations are not active NOTAMs
      var s=sig(t);
      if(!byS[s]){
        n._c=cat(t); n._fac=fac(t); n._cat=categorize(n); n._local=nearField(n,ref); n._nums=[]; n._dups=0;
        byS[s]=n; order.push(s);
      }
      var g=byS[s];
      if(n.number && g._nums.indexOf(n.number)<0) g._nums.push(n.number);
      g._dups++;
    }
    var all=[], counts={ cat:{}, local:0, regional:0 };
    for(var j=0;j<order.length;j++){ var it=byS[order[j]];
      all.push(it);
      counts.cat[it._cat]=(counts.cat[it._cat]||0)+1;
      if(it._local) counts.local++; else counts.regional++;
    }
    all.sort(function(a,b){ return (a._c.pri-b._c.pri) || facRank(a._fac).localeCompare(facRank(b._fac)) || 0; });
    return { items: all, total: all.length, counts: counts };
  }

  // ---- live filter state ----
  w.PWNotam = w.PWNotam || {};
  var FILTER = { cats: Object.assign({}, DEFAULT_ON), src: { local:true, regional:false } };
  // Field-surface categories are always about the airport you selected (its runways/taxiways/field), so they
  // must never be hidden behind the Local/Regional source toggle — only broader-area NOTAMs (airspace, obstacle,
  // TFR, GPS, procedures, other) respect Local/Regional.
  var FIELD_CATS = { Airport:1, Runway:1, Taxiway:1 };
  function visible(it){
    if(!FILTER.cats[it._cat]) return false;
    if(FIELD_CATS[it._cat]) return true;
    if(!((FILTER.src.local && it._local) || (FILTER.src.regional && !it._local))) return false;
    return true;
  }
  function applyFilter(arr){ return arr.filter(visible); }

  // ---- filter chip bar (ForeFlight-style) ----
  function renderBar(barEl, agg, onToggle){
    if(!barEl) return;
    var allsty='font:600 10.5px system-ui;border:1px solid #c6d0de;background:#f4f8ff;color:#0b3d91;border-radius:6px;padding:2px 8px;cursor:pointer;margin-left:6px;vertical-align:1px';
    var h='<div class="nf-sec">Category'
        +'<button type="button" class="nf-all" data-all="1" style="'+allsty+'">Select all</button>'
        +'<button type="button" class="nf-all" data-all="0" style="'+allsty+'">Clear</button>'
        +'</div><div class="nf-row">';
    CATS.forEach(function(c){
      var n=(agg.cat&&agg.cat[c])||0, on=!!FILTER.cats[c];
      h+='<button type="button" class="nf-chip'+(on?' on':'')+'" data-k="cat" data-v="'+c+'"'+(n===0?' style="opacity:.4"':'')+'>'+c+' <b>'+n+'</b></button>';
    });
    h+='</div><div class="nf-sec">Source</div><div class="nf-row">';
    [['local','Local',(agg.local||0)],['regional','Regional',(agg.regional||0)]].forEach(function(s){
      h+='<button type="button" class="nf-chip'+(FILTER.src[s[0]]?' on':'')+'" data-k="src" data-v="'+s[0]+'"'+(s[2]===0?' style="opacity:.4"':'')+'>'+s[1]+' <b>'+s[2]+'</b></button>';
    });
    h+='</div>';
    barEl.innerHTML=h;
    barEl.querySelectorAll('.nf-chip').forEach(function(b){
      b.onclick=function(){ var k=b.getAttribute('data-k'), v=b.getAttribute('data-v');
        if(k==='cat') FILTER.cats[v]=!FILTER.cats[v]; else FILTER.src[v]=!FILTER.src[v];
        if(onToggle) onToggle(); };
    });
    // Select all / Clear: flip every category on/off, then refresh the list (same onToggle).
    barEl.querySelectorAll('.nf-all').forEach(function(b){
      b.onclick=function(){ var on=b.getAttribute('data-all')==='1'; CATS.forEach(function(c){ FILTER.cats[c]=on?1:0; }); if(onToggle) onToggle(); };
    });
  }

  function line(n, etaMs, role){
    var eff=fmt(n.start)+(n.end?'–'+fmt(n.end):'');
    var dup=n._dups>1?' <span style="color:#9aa7b4">×'+n._dups+'</span>':'';
    var reg=n._local?'':' <span class="nf-reg">REGIONAL</span>';
    var ts=timeStatus(n, etaMs, role);
    var tb=' <span class="nf-time" style="background:'+ts.col+'">'+ts.label+'</span>';
    return '<span class="raw"'+(ts.dim?' style="opacity:.5"':'')+'><span class="ntag" style="background:'+n._c.color+'">'+n._c.label+'</span>'+tb+' '+(eff?'['+eff+'] ':'')+esc(plain(n.text))+dup+reg+'</span>';
  }

  function renderList(blk, p, arr, mode, rawN){
    var vis=applyFilter(arr), shown=vis.length, hidden=arr.length-shown;
    var etaMs=(typeof w.PW_arrivalMs==='function')?w.PW_arrivalMs(p.id):null;
    var role=(typeof w.PW_timeRole==='function')?w.PW_timeRole(p.id):'ETA';
    var _meta=shown+' shown'+(hidden?' · '+hidden+' filtered':'')+' · '+arr.length+' total'+(etaMs!=null?' · '+role+'-aware':'');
    var head='<div class="na-head"><b>'+p.id+'</b><span class="na-meta">'+_meta+'</span><div class="na-links">'+diagLinks(p,arr).replace(/^\s*·\s*/,'').replace(/\s*·\s*/g,'')+'</div></div>';
    if(mode==='plain'){
      var sigItems=vis.filter(function(n){return n._c.pri<=2;});
      var hp=head;
      if(!vis.length){ hp+='<span class="sub">No NOTAMs match the current filter — adjust the chips above.</span>'; blk.innerHTML=hp; return; }
      hp+=sigItems.slice(0,10).map(function(n){ return '<span class="raw"><span class="ntag" style="background:'+n._c.color+'">'+n._c.label+'</span>'+esc(plain(n.text).split(/\.\s|;\s/)[0]).slice(0,120)+'</span>'; }).join('');
      if(!sigItems.length) hp+='<span class="sub">Nothing critical in the current filter; switch mode to Off for the full filtered list.</span>';
      blk.innerHTML=hp; return;
    }
    // 'off' — critical (closures/hard) first, then grouped by facility
    if(!vis.length){ blk.innerHTML=head+'<span class="sub">No NOTAMs match the current filter — adjust the chips above.</span>'; return; }
    var hard=vis.filter(isHardStop);
    var rest=vis.filter(function(n){return !isHardStop(n);});
    var h=head;
    if(hard.length){
      h+='<span class="sub" style="color:#c0392b;font-weight:600">⚑ Critical — closures &amp; hard stops ('+hard.length+')</span>';
      var lf=null;
      hard.forEach(function(n){ if(n._fac&&n._fac!==lf){ h+='<span class="sub" style="opacity:.75">'+esc(n._fac)+'</span>'; lf=n._fac; } h+=line(n,etaMs,role); });
    }
    var cap=Math.max(10, 40-hard.length), showRest=rest.slice(0,cap), lf2=null;
    if(showRest.length) h+='<span class="sub" style="opacity:.75;margin-top:4px">Advisory</span>';
    showRest.forEach(function(n){ if(n._fac&&n._fac!==lf2){ h+='<span class="sub" style="opacity:.75">'+esc(n._fac)+'</span>'; lf2=n._fac; } h+=line(n,etaMs,role); });
    var more=vis.length-hard.length-showRest.length;
    if(more>0) h+='<span class="sub">…'+more+' more in filter — see <a class="inline" href="https://notams.aim.faa.gov/notamSearch/" target="_blank">FAA NOTAM Search ↗</a></span>';
    blk.innerHTML=h;
  }

  w.PWNotam.triage = triage;
  w.PWNotam.renderList = renderList;
  w.PWNotam.renderBar = renderBar;
  w.PWNotam.applyFilter = applyFilter;
  w.PWNotam.diagLinks = diagLinks;
  w.PWNotam.filter = FILTER;
  w.PWNotam.CATS = CATS;
})(window);
