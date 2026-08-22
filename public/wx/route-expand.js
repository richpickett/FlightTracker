/* Personal Wings shared route expander.
   DB = {airports, navaids, fixes, airways, procedures}
   expand(routeStr, DB) -> {points:[{id,la,lo,kind}], unresolved:[..], notes:[..]} */
(function(root){
  function up(s){return (s||'').trim().toUpperCase();}
  function toks(s){return up(s).split(/[^A-Z0-9]+/).filter(Boolean);}
  function coord(id,DB){
    if(DB.fixes[id]) return {ll:DB.fixes[id],kind:'fix'};
    if(DB.navaids[id]) return {ll:DB.navaids[id],kind:'nav'};
    if(DB.airports[id]) return {ll:[DB.airports[id][0],DB.airports[id][1]],kind:'apt'};
    if(DB.airports['K'+id]) return {ll:[DB.airports['K'+id][0],DB.airports['K'+id][1]],kind:'apt'};
    return null;
  }
  function airport(id,DB){
    if(DB.airports[id]) return {ll:[DB.airports[id][0],DB.airports[id][1]],id:id};
    if(DB.airports['K'+id]) return {ll:[DB.airports['K'+id][0],DB.airports['K'+id][1]],id:'K'+id};
    return null;
  }
  // choose a SID/STAR transition fix-list given an adjacent connecting token
  function pickTrans(proc, connectTok, DB){
    if(!proc) return null;
    if(connectTok && proc.enr && proc.enr[connectTok]) return proc.enr[connectTok];
    // else transition whose last fix == connectTok
    if(connectTok && proc.enr){ for(var k in proc.enr){ var a=proc.enr[k]; if(a.length&&a[a.length-1]===connectTok) return a; } }
    if(proc.common && proc.common.length) return proc.common;
    if(proc.enr){ var ks=Object.keys(proc.enr); if(ks.length===1) return proc.enr[ks[0]]; }
    // last resort: any runway transition (near-field fixes)
    if(proc.rwy){ var rk=Object.keys(proc.rwy); if(rk.length) return proc.rwy[rk[0]]; }
    return proc.common||[];
  }
  function d2(a,b){var dx=a[0]-b[0],dy=a[1]-b[1];return dx*dx+dy*dy;}
  function nearestIdx(seq, ll, DB){ var bi=-1,bd=1e18; for(var k=0;k<seq.length;k++){ var c=coord(seq[k],DB); if(!c)continue; var dd=d2(c.ll,ll); if(dd<bd){bd=dd;bi=k;} } return bi; }
  function airwaySlice(seq, fromId, toId, prevLL, nextLL, DB){
    var i=seq.indexOf(fromId), j=(toId?seq.indexOf(toId):-1);
    if(i<0 && prevLL) i=nearestIdx(seq,prevLL,DB);
    if(j<0 && nextLL) j=nearestIdx(seq,nextLL,DB);
    if(i<0 && j<0) return seq.slice();
    if(i<0) i=0; if(j<0) j=seq.length-1;
    if(i<=j) return seq.slice(i, j+1);
    return seq.slice(j, i+1).reverse();
  }
  function expand(routeStr, DB){
    var t=toks(routeStr), pts=[], unresolved=[], notes=[], ids=[];
    if(t.length<2){ return {points:[],unresolved:t,notes:['need ≥2 identifiers']}; }
    var depId=t[0], destId=t[t.length-1];
    var last=t.length-1;
    // push a resolved ident onto the id list
    function pushId(id){ if(!id) return; if(ids.length && ids[ids.length-1]===id) return; ids.push(id); }
    // departure airport
    var dep=airport(depId,DB); if(dep){ pushId(dep.id);} else { unresolved.push(depId); pushId(depId); }
    for(var i=1;i<last;i++){
      var tk=t[i], prev=t[i-1], next=t[i+1];
      if(tk==='DCT'||tk==='DIRECT'){ continue; }   // "direct to next point" — a connector, not a fix; skip (not an error)
      var sidP = (i===1 && dep && DB.procedures[dep.id] && DB.procedures[dep.id].D && DB.procedures[dep.id].D[tk]) ? DB.procedures[dep.id].D[tk] : null;
      var destApt = airport(destId,DB);
      var starP = (i===last-1 && destApt && DB.procedures[destApt.id] && DB.procedures[destApt.id].E && DB.procedures[destApt.id].E[tk]) ? DB.procedures[destApt.id].E[tk] : null;
      if(sidP){ var seq=pickTrans(sidP,next,DB)||[]; notes.push('SID '+tk); seq.forEach(pushId); continue; }
      if(starP){ var seq2=pickTrans(starP,prev,DB)||[]; notes.push('STAR '+tk); seq2.forEach(pushId); continue; }
      if(DB.airways[tk]){ var pc=coord(ids[ids.length-1],DB), nc=coord(next,DB); var sl=airwaySlice(DB.airways[tk], ids[ids.length-1], next, pc&&pc.ll, nc&&nc.ll, DB); notes.push('AWY '+tk); sl.forEach(pushId); continue; }
      // plain fix/navaid/airport
      if(coord(tk,DB)) pushId(tk); else { unresolved.push(tk); }
    }
    // destination airport
    var dst=airport(destId,DB); if(dst){ pushId(dst.id);} else { unresolved.push(destId); pushId(destId); }
    // resolve ids -> points
    ids.forEach(function(id){ var c=coord(id,DB); if(c){ pts.push({id:id,la:c.ll[0],lo:c.ll[1],kind:c.kind}); } else if(unresolved.indexOf(id)<0){ unresolved.push(id); } });
    // drop adjacent dup coords
    var outp=[]; pts.forEach(function(p){ var q=outp[outp.length-1]; if(!q||q.la!==p.la||q.lo!==p.lo) outp.push(p); });
    return {points:outp, unresolved:unresolved, notes:notes};
  }
  var api={expand:expand};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  root.PWRoute=api;
})(typeof window!=='undefined'?window:this);
