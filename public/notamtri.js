/* Personal Wings — NOTAM triage (dedupe + geo-relevance + operational grouping).
   Layers on top of the briefing's existing notamCat()/notamPlain()/nesc()/fmtNz() globals.
   PWNotam.triage(list, refLatLon) -> { items, total, dropped }
   PWNotam.renderList(blk, p, arr, total, dropped, mode, rawN)   // mode: 'off' | 'plain'
*/
(function (w) {
  function esc(s){ return (w.nesc ? w.nesc(s) : String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];})); }
  function plain(t){ return w.notamPlain ? w.notamPlain(t) : String(t); }
  function cat(t){ return w.notamCat ? w.notamCat(t) : {label:'OTHER',color:'#6b7280',pri:4}; }
  function fmt(s){ return w.fmtNz ? w.fmtNz(s) : (s||''); }
  // Link to the official FAA airport diagram (SkyVector shows it directly).
  function diag(id){ return ' · <a class="inline" href="https://skyvector.com/airport/'+encodeURIComponent(id)+'" target="_blank" rel="noopener">✈ Airport diagram (FAA) ↗</a>'; }
  // Build the header diagram links (+ a "show closed taxiways" trigger when there are taxiway closures) and stash modal data.
  function diagLinks(p, arr){
    w.__pwdiag = w.__pwdiag || {}; w.__pwdiag[p.id] = { lat:p.la, lon:p.lo, items:arr };
    var hasClose = arr.some(function(n){ var u=(n.text||'').toUpperCase(); return /\b(TWY|RWY)\b/.test(u) && /\bCLSD\b/.test(u); });
    var closures = (hasClose && w.PWDiagram) ? ' · <a class="inline pw-lock" href="#" onclick="try{PWDiagram.open(\''+p.id+'\')}catch(e){};return false;">⊘ Show closed TWY/RWY</a>' : '';
    return diag(p.id) + closures;
  }

  // Dedup signature — collapses FNS+SWIM double-listings and reissues (identical/near-identical text).
  function sig(t){
    return String(t||'').toUpperCase().replace(/\s+/g,' ')
      .replace(/\d{6,}/g,' ')                             // date/time stamps (6+ digits) — no \b so it also strips "2609082132EST" (glued to EST)
      .replace(/\b(EST|EDT|UTC|ESTIMATED|PERM)\b/g,' ')   // timezone / estimated markers left behind by the stamp strip
      .replace(/\b(SID|STAR|ODP|IAP|VFP|NAV|SVC|DP)\b/g,' ') // FNS vs SWIM chart-type prefixes
      .replace(/\d{4}-[A-Z]{3}-\d{3,6}-OE/g,' ')          // obstacle-eval ids (e.g. 2025-AWP-22757-OE) differ across reissues of the same crane
      .replace(/[^A-Z0-9/ ]/g,' ').replace(/\s+/g,' ').trim();
  }
  // Facility the NOTAM is about, so RWY/SID/TWY items cluster together.
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
  var RADIUS_NM=50;

  function triage(list, ref){
    var byS={}, order=[];
    for(var i=0;i<list.length;i++){
      var n=list[i], t=(n.text||''); if(!t) continue;
      var s=sig(t);
      if(!byS[s]){
        n._c=cat(t); n._fac=fac(t); n._nums=[]; n._dups=0; n._far=false;
        if(ref){ var cs=parseCoords(t); if(cs.length){ var dm=Infinity; for(var k=0;k<cs.length;k++){ var dd=distNM(ref,cs[k]); if(dd<dm) dm=dd; } n._dist=dm; n._far=dm>RADIUS_NM; } }
        byS[s]=n; order.push(s);
      }
      var g=byS[s];
      if(n.number && g._nums.indexOf(n.number)<0) g._nums.push(n.number);
      g._dups++;
    }
    var all=[], far=0;
    for(var j=0;j<order.length;j++){ var it=byS[order[j]]; if(it._far) far++; else all.push(it); }
    all.sort(function(a,b){ return (a._c.pri-b._c.pri) || facRank(a._fac).localeCompare(facRank(b._fac)) || 0; });
    return { items: all, total: all.length, dropped: far };
  }

  function line(n){
    var eff=fmt(n.start)+(n.end?'–'+fmt(n.end):'');
    var dup=n._dups>1?' <span style="color:#9aa7b4">×'+n._dups+'</span>':'';
    return '<span class="raw"><span class="ntag" style="background:'+n._c.color+'">'+n._c.label+'</span>'+(eff?'['+eff+'] ':'')+esc(plain(n.text))+dup+'</span>';
  }

  function renderList(blk, p, arr, total, dropped, mode, rawN){
    if(mode==='plain'){
      var sigItems=arr.filter(function(n){return n._c.pri<=2;}), byCat={};
      arr.forEach(function(n){ byCat[n._c.label]=(byCat[n._c.label]||0)+1; });
      var counts=Object.keys(byCat).map(function(k){return byCat[k]+' '+k;}).join(', ');
      var hp='<b>'+p.id+'</b> <span style="color:#889">'+total+' after dedupe'+(dropped?' · '+dropped+' regional dropped':'')+' · '+counts+'</span>'+diagLinks(p,arr);
      hp+=sigItems.slice(0,8).map(function(n){ return '<span class="raw"><span class="ntag" style="background:'+n._c.color+'">'+n._c.label+'</span>'+esc(plain(n.text).split(/\.\s|;\s/)[0]).slice(0,120)+'</span>'; }).join('');
      if(!sigItems.length) hp+='<span class="sub">No runway/approach/airspace items. Switch to Off for the full list.</span>';
      blk.innerHTML=hp; return;
    }
    // 'off' — hard stops first, then grouped by facility
    var hard=arr.filter(function(n){return n._c.pri<=1;});
    var rest=arr.filter(function(n){return n._c.pri>1;});
    var h='<b>'+p.id+'</b> <span style="color:#889">'+rawN+' raw · '+total+' after dedupe'+(dropped?' · '+dropped+' regional dropped':'')+'</span>'+diagLinks(p,arr);
    if(hard.length){
      h+='<span class="sub" style="color:#c0392b;font-weight:600">⚑ Critical — closures &amp; airspace ('+hard.length+')</span>';
      var lf=null;
      hard.forEach(function(n){ if(n._fac&&n._fac!==lf){ h+='<span class="sub" style="opacity:.75">'+esc(n._fac)+'</span>'; lf=n._fac; } h+=line(n); });
    }
    var cap=Math.max(6, 26-hard.length), shown=rest.slice(0,cap), lf2=null;
    if(shown.length) h+='<span class="sub" style="opacity:.75;margin-top:4px">Advisory</span>';
    shown.forEach(function(n){ if(n._fac&&n._fac!==lf2){ h+='<span class="sub" style="opacity:.75">'+esc(n._fac)+'</span>'; lf2=n._fac; } h+=line(n); });
    var more=total-hard.length-shown.length;
    if(more>0 || dropped) h+='<span class="sub">…'+(more>0?more+' more':'')+(dropped?(more>0?', ':'')+dropped+' regional/enroute':'')+' — see <a class="inline" href="https://notams.aim.faa.gov/notamSearch/" target="_blank">FAA NOTAM Search ↗</a></span>';
    blk.innerHTML=h;
  }

  w.PWNotam = { triage: triage, renderList: renderList, diagLinks: diagLinks };
})(window);
