/* Personal Wings — Surface Prog renderer (shared by briefing + animated /wx map).
   Draws AWC/WPC fronts (barbed), isobars, H/L and pressure labels on a Leaflet map
   via a canvas overlay, plus the NDFD weather PNG as an image overlay.
   Usage:
     var prog = PWProg.attach(map, {
       bbox:[minLon,minLat,maxLon,maxLat],   // optional; defaults to current map bounds
       fhrs:[0,6,12,18],                      // forecast hours to load
       weather:true,                          // show weather shading
       controlEl:document.getElementById('mapleg'),  // optional: render frame buttons + legend here
       onReady:function(p){}                  // called after data loads
     });
     prog.setFrame(i);  prog.frameNearest(epochSec);  prog.toggleWeather(bool);  prog.remove();
*/
(function (w) {
  var COL = { cold:'#2f6fed', warm:'#e5484d', occ:'#8b5cf6', stat:'#12a594', trough:'#b0812f', iso:'rgba(68,80,97,.9)' };

  function attach(map, opts) {
    opts = opts || {};
    if (map._pwProg) { try { map._pwProg.remove(); } catch (e) {} }   // idempotent: drop a prior instance
    var api = (opts.endpoint || '/.netlify/functions/progchart');
    var cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:450';
    map.getContainer().appendChild(cv);
    var ctx = cv.getContext('2d');
    var frames = [], cur = null, wxLayer = null, wxOn = opts.weather !== false, wxBounds = null, removed = false;

    function P(c){ return map.latLngToContainerPoint([c[1], c[0]]); }         // [lon,lat] -> screen pt
    function size(){ var s = map.getSize(); cv.width = s.x; cv.height = s.y; cv.style.width = s.x+'px'; cv.style.height = s.y+'px'; }
    function line(pts,color,wt,dash){ ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=wt; ctx.setLineDash(dash||[]); ctx.lineJoin='round';
      ctx.beginPath(); for(var i=0;i<pts.length;i++){ i?ctx.lineTo(pts[i].x,pts[i].y):ctx.moveTo(pts[i].x,pts[i].y); } ctx.stroke(); ctx.restore(); }
    function pips(pts,cb){ var acc=0,gap=24,next=13; for(var i=1;i<pts.length;i++){ var a=pts[i-1],b=pts[i],seg=Math.hypot(b.x-a.x,b.y-a.y); if(seg<0.01)continue;
      var ang=Math.atan2(b.y-a.y,b.x-a.x); while(next<=acc+seg){ var t=(next-acc)/seg; cb(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,ang); next+=gap; } acc+=seg; } }
    function tri(x,y,ang,side,color,h){ var p=ang+side*Math.PI/2,hb=5;
      var ax=x+Math.cos(p)*h, ay=y+Math.sin(p)*h, bx=x+Math.cos(ang)*hb, by=y+Math.sin(ang)*hb, dx=x-Math.cos(ang)*hb, dy=y-Math.sin(ang)*hb;
      ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(ax,ay); ctx.lineTo(dx,dy); ctx.closePath(); ctx.fillStyle=color; ctx.fill(); }
    function semi(x,y,ang,side,color,r){ ctx.beginPath(); ctx.arc(x,y,r,ang,ang+Math.PI, side<0); ctx.closePath(); ctx.fillStyle=color; ctx.fill(); }

    function redraw(){
      if(removed || !cur) return; size(); ctx.clearRect(0,0,cv.width,cv.height);
      var f, i;
      for(i=0;i<cur.feats.length;i++){ f=cur.feats[i]; if(f.t===1) line(f.c.map(P), COL.iso, 1.5); }
      for(i=0;i<cur.feats.length;i++){ f=cur.feats[i]; if(f.t!==2) continue;
        var name=(f.front||'').replace(/^-/,''), diss=/^-/.test(f.front||''), pts=f.c.map(P), side=f.pip===2?1:-1, k=0;
        ctx.globalAlpha = diss?0.5:1;
        if(/Trough/.test(name)) line(pts, COL.trough, 1.6, [7,6]);
        else if(/Cold/.test(name)){ line(pts,COL.cold,2.4); pips(pts,function(x,y,a){ tri(x,y,a,side,COL.cold,9); }); }
        else if(/Warm/.test(name)){ line(pts,COL.warm,2.4); pips(pts,function(x,y,a){ semi(x,y,a,side,COL.warm,6); }); }
        else if(/Occluded/.test(name)){ line(pts,COL.occ,2.4); pips(pts,function(x,y,a){ (k++%2)?semi(x,y,a,side,COL.occ,6):tri(x,y,a,side,COL.occ,9); }); }
        else if(/Stationary/.test(name)){ line(pts,COL.stat,2.2); pips(pts,function(x,y,a){ (k++%2)?tri(x,y,a,-1,COL.cold,8):semi(x,y,a,1,COL.warm,5); }); }
        else line(pts, COL.trough, 1.6, [7,6]);
        ctx.globalAlpha = 1;
      }
      ctx.textAlign='center'; ctx.textBaseline='middle';
      for(i=0;i<cur.feats.length;i++){ f=cur.feats[i]; var s;
        if(f.t===15){ s=P(f.c); var isH=f.code==='high'; ctx.font='800 18px sans-serif';
          ctx.strokeStyle='rgba(255,255,255,.9)'; ctx.lineWidth=3.5; ctx.strokeText(isH?'H':'L',s.x,s.y);
          ctx.fillStyle=isH?'#0b63d6':'#d61f26'; ctx.fillText(isH?'H':'L',s.x,s.y);
        } else if(f.t===21){ s=P(f.c); ctx.font='700 12px ui-monospace,monospace';
          ctx.strokeStyle='rgba(255,255,255,.92)'; ctx.lineWidth=3.5; ctx.strokeText(f.text,s.x,s.y);
          ctx.fillStyle='#243247'; ctx.fillText(f.text,s.x,s.y); }
      }
    }
    map.on('move zoom viewreset resize zoomanim', redraw);

    function applyWx(){
      if(wxLayer){ map.removeLayer(wxLayer); wxLayer=null; }
      if(wxOn && cur && cur.wxUrl && wxBounds){ wxLayer = L.imageOverlay(cur.wxUrl, wxBounds, {opacity:0.6}); wxLayer.addTo(map); if(map.hasLayer(wxLayer)) wxLayer.bringToBack(); }
    }
    function setFrame(idx){ if(!frames.length) return; idx=Math.max(0,Math.min(frames.length-1,idx)); cur=frames[idx]; api_cur=idx; applyWx(); redraw(); renderControl(); }
    function frameNearest(epochSec){ if(!frames.length) return; var best=0,bd=Infinity; frames.forEach(function(fr,i){ var d=Math.abs(fr.vsecs-epochSec); if(d<bd){bd=d;best=i;} }); setFrame(best); }
    var api_cur = 0;

    function renderControl(){
      var el = opts.controlEl; if(!el) return;
      var vt = cur ? cur.valid : '';
      var html = '<div class="pwprog-frames" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:4px">';
      frames.forEach(function(fr,i){ var lbl = fr.fhr===0?'Analysis':('+'+fr.fhr+'h');
        html += '<button data-i="'+i+'" style="font:600 11px sans-serif;padding:3px 8px;border-radius:6px;border:1px solid #cdd6df;cursor:pointer;background:'+(i===api_cur?'#2f6fed':'#fff')+';color:'+(i===api_cur?'#fff':'#33414f')+'">'+lbl+'</button>'; });
      html += '<button data-wx="1" style="font:600 11px sans-serif;padding:3px 8px;border-radius:6px;border:1px solid #cdd6df;cursor:pointer;background:'+(wxOn?'#2f6fed':'#fff')+';color:'+(wxOn?'#fff':'#33414f')+'">Wx</button>';
      html += '<span style="font:600 11px sans-serif;color:#6b7a8d">valid '+vt+' UTC</span></div>';
      html += '<div style="font-size:11px;color:#6b7a8d;display:flex;gap:12px;flex-wrap:wrap">'
        + swatch(COL.cold,'Cold') + swatch(COL.warm,'Warm') + swatch(COL.occ,'Occluded') + swatch(COL.stat,'Stationary')
        + swatch(COL.trough,'Trough',true) + '<span><b style="color:#0b63d6">H</b>/<b style="color:#d61f26">L</b></span></div>';
      el.innerHTML = html;
      Array.prototype.forEach.call(el.querySelectorAll('button[data-i]'), function(b){ b.onclick=function(){ setFrame(+b.getAttribute('data-i')); }; });
      var wxb = el.querySelector('button[data-wx]'); if(wxb) wxb.onclick=function(){ toggleWeather(!wxOn); };
    }
    function swatch(c,label,dash){ return '<span><span style="display:inline-block;width:16px;height:0;border-top:3px '+(dash?'dashed':'solid')+' '+c+';vertical-align:middle;margin-right:4px"></span>'+label+'</span>'; }

    function toggleWeather(b){ wxOn = !!b; applyWx(); renderControl(); }
    function remove(){ removed=true; map.off('move zoom viewreset resize zoomanim', redraw); if(wxLayer) map.removeLayer(wxLayer); if(cv.parentNode) cv.parentNode.removeChild(cv); if(map._pwProg===ctrl) map._pwProg=null; }

    var ctrl = { setFrame:setFrame, frameNearest:frameNearest, toggleWeather:toggleWeather, remove:remove, get frames(){ return frames; } };
    map._pwProg = ctrl;

    // fetch
    var bbox = opts.bbox;
    if(!bbox){ var b=map.getBounds(); bbox=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()]; }
    var url = api + '?fhrs=' + (opts.fhrs||[0,6,12,18]).join(',') + '&bbox=' + bbox.map(function(n){return n.toFixed(2);}).join(',');
    fetch(url).then(function(r){return r.json();}).then(function(d){
      if(removed) return;
      wxBounds = d.wxBounds || [[21,-125],[50,-66.5]];
      frames = (d.frames||[]).filter(function(f){ return f && f.feats; });
      if(!frames.length){ if(opts.controlEl) opts.controlEl.innerHTML='<span style="font-size:11px;color:#6b7a8d">Surface prog unavailable.</span>'; return; }
      setFrame(0);
      if(opts.onReady) opts.onReady(ctrl);
    }).catch(function(e){ if(opts.controlEl) opts.controlEl.innerHTML='<span style="font-size:11px;color:#6b7a8d">Surface prog error.</span>'; });

    return ctrl;
  }

  w.PWProg = { attach: attach };
})(window);
