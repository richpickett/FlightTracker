/* Personal Wings — accounts + saved routes widget.
   Requires @supabase/supabase-js (v2) loaded before this file, and a page that
   defines window.PW_getState() -> {route, aircraft} and window.PW_applyState(obj). */
(function(){
  var SB=null, USER=null, cfg={}, TRIG=null, RECOVERY=false, PROFILE={};
  function $(s,r){return (r||document).querySelector(s);}
  function esc(s){return (s||'').replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];});}
  function style(){var s=document.createElement('style');s.textContent=
   '#pwacct-btn{position:fixed;right:12px;top:12px;z-index:3000;background:#0b3d91;color:#fff;border:none;border-radius:20px;padding:8px 13px;font:600 13px system-ui;cursor:pointer;box-shadow:0 2px 8px #0006}'+
   '#pwacct{position:fixed;right:12px;top:56px;z-index:3000;width:300px;max-width:92vw;background:#fff;color:#1a2230;border:1px solid #d8e0ea;border-radius:12px;padding:12px;box-shadow:0 12px 34px #0b3d9126;font:13px system-ui;display:none}'+
   '#pwacct.open{display:block} #pwacct h4{margin:0 0 8px;font-size:14px;color:#0b3d91}'+
   '#pwacct input{width:100%;box-sizing:border-box;margin:4px 0;background:#f7faff;border:1px solid #d8e0ea;color:#1a2230;border-radius:7px;padding:8px}'+
   '#pwacct button{background:#0b3d91;color:#fff;border:none;border-radius:7px;padding:7px 10px;font:600 13px system-ui;cursor:pointer;margin:4px 4px 0 0}'+
   '#pwacct button.sec{background:#eef2f7;color:#0b3d91} #pwacct .row{display:flex;justify-content:space-between;align-items:center;gap:6px;border-bottom:1px solid #eef2f7;padding:5px 0}'+
   '#pwacct .row a{color:#0b3d91;cursor:pointer;text-decoration:none;font-weight:600} #pwacct .msg{color:#b45309;font-size:12px;margin:5px 0;min-height:14px}'+
   '#pwacct .muted{color:#6b7889;font-size:12px} #pwacct a.link{color:#0b3d91;cursor:pointer}';
   document.head.appendChild(s);}
  function msg(m){ // write to the currently-visible .msg (signin vs signup vs routes); clear the hidden one
    var els=document.querySelectorAll('#pwacct .msg');
    for(var i=0;i<els.length;i++){ els[i].textContent = (els[i].offsetParent!==null) ? (m||'') : ''; }
  }
  function softErr(m){ m=m||'Something went wrong.';
    var t=/after (\d+) seconds/i.exec(m);
    if(t) return 'Please wait '+t[1]+'s before trying again — the server limits repeated email requests.';
    if(/rate limit/i.test(m)) return 'Too many attempts just now — wait a moment and try again.';
    if(/Email not confirmed/i.test(m)) return 'Confirm your email first — check your inbox for the link, then sign in.';
    if(/Invalid login/i.test(m)) return 'Email or password is incorrect.';
    return m;
  }

  function render(){
    var p=$('#pwacct'); if(!p) return;
    if(RECOVERY){
      p.innerHTML='<h4>Set a new password</h4>'+
        '<input id="pw-newpass" type="password" placeholder="new password (8+ chars)" autocomplete="new-password">'+
        '<input id="pw-newpass2" type="password" placeholder="confirm new password" autocomplete="new-password">'+
        '<button id="pw-setpass">Update password</button><div class="msg"></div>';
      $('#pw-setpass').onclick=setNewPass;
      return;
    }
    if(!USER){
      p.innerHTML='<h4>Personal Wings — Sign in</h4>'+
        '<div id="pwsignin"><input id="pw-email" type="email" placeholder="email" autocomplete="email">'+
        '<input id="pw-pass" type="password" placeholder="password" autocomplete="current-password">'+
        '<button id="pw-in">Sign in</button><button id="pw-showup" class="sec">Create account</button>'+
        '<div style="margin-top:4px"><a class="link" id="pw-forgot">Forgot password?</a></div>'+
        '<div class="msg"></div></div>'+
        '<div id="pwsignup" style="display:none"><input id="pw-name" placeholder="full name">'+
        '<input id="pw-email2" type="email" placeholder="email"><input id="pw-pass2" type="password" placeholder="password (8+ chars)">'+
        '<button id="pw-up">Create account</button><button id="pw-showin" class="sec">Back to sign in</button><div class="msg"></div></div>';
      $('#pw-in').onclick=signIn; $('#pw-up').onclick=signUp; $('#pw-forgot').onclick=forgotPw;
      $('#pw-showup').onclick=function(){$('#pwsignin').style.display='none';$('#pwsignup').style.display='block';msg('');};
      $('#pw-showin').onclick=function(){$('#pwsignup').style.display='none';$('#pwsignin').style.display='block';msg('');};
    } else {
      p.innerHTML='<h4>My Routes</h4><div class="muted" id="pw-who"></div>'+
        '<input id="pw-rname" placeholder="name this route (e.g. KATW→BDU)">'+
        '<button id="pw-save">Save current route</button><div class="msg"></div>'+
        '<div id="pw-list" style="margin-top:6px"></div>'+
        '<div style="margin-top:10px;border-top:1px solid #eef2f7;padding-top:8px">'+
          '<div class="muted" style="margin-bottom:2px">My default aircraft (tail #)</div>'+
          '<div style="display:flex;gap:6px"><input id="pw-reg" placeholder="N123AB" style="text-transform:uppercase;flex:1;margin:0" value="'+esc(PROFILE.default_reg||'')+'"><button id="pw-regsave" class="sec" style="margin:0">Set</button></div>'+
        '</div>'+
        '<div style="margin-top:10px"><a class="link" id="pw-out">Sign out</a></div>';
      $('#pw-who').textContent=(USER.user_metadata&&USER.user_metadata.name?USER.user_metadata.name+' · ':'')+USER.email;
      $('#pw-save').onclick=saveRoute; $('#pw-out').onclick=signOut; $('#pw-regsave').onclick=saveDefaultReg; listRoutes();
    }
  }
  function toggle(){var p=$('#pwacct'); p.classList.toggle('open'); var open=p.classList.contains('open'); var cb=document.getElementById('pwacct-close'); if(cb) cb.style.display=open?'block':'none'; if(open) render();}

  function signIn(){var e=$('#pw-email').value.trim(),pw=$('#pw-pass').value;
    if(!e||!pw){msg('Enter email and password.');return;}
    msg('Signing in…');
    SB.auth.signInWithPassword({email:e,password:pw}).then(function(r){ if(r.error) msg(softErr(r.error.message)); else msg(''); });}
  function signUp(){var n=$('#pw-name').value.trim(),e=$('#pw-email2').value.trim(),pw=$('#pw-pass2').value;
    if(!n){msg('Enter your name');return;}
    if(!e||!pw){msg('Enter email and password.');return;}
    msg('Creating account…');
    SB.auth.signUp({email:e,password:pw,options:{data:{name:n},emailRedirectTo:location.origin}}).then(function(r){
      if(r.error){msg(softErr(r.error.message));return;}
      msg(r.data.session?'Account created — you\'re in.':'✓ Confirmation email sent to '+e+'. Open it, confirm, then come back and sign in.');});}
  function forgotPw(){var e=$('#pw-email').value.trim();
    if(!e){msg('Type your email above, then tap Forgot password.');return;}
    msg('Sending reset link…');
    SB.auth.resetPasswordForEmail(e,{redirectTo:location.origin}).then(function(r){
      if(r.error){msg(softErr(r.error.message));return;}
      msg('✓ Password-reset link sent to '+e+'. Check your inbox.');});}
  function signOut(){ RECOVERY=false; PROFILE={}; SB.auth.signOut(); }
  function fetchProfile(){ if(!USER) return;
    SB.from('profiles').select('*').eq('id',USER.id).single().then(function(r){
      PROFILE=r.data||{};
      var rr=$('#pw-reg'); if(rr) rr.value=PROFILE.default_reg||'';
      // aircraft fleet sync: server wins if it holds aircraft; otherwise push up any local fleet (first-device upload)
      var sf=PROFILE.fleet;
      if(sf && sf.list && Object.keys(sf.list).length){
        if(window.PW_applyFleet) window.PW_applyFleet(sf);
        else if(PROFILE.default_reg && window.PW_setReg) window.PW_setReg(PROFILE.default_reg);
      } else {
        if(window.PW_getFleet){ var lf=window.PW_getFleet(); if(lf && lf.list && Object.keys(lf.list).length) pushFleet(lf); }
        if(PROFILE.default_reg && window.PW_setReg) window.PW_setReg(PROFILE.default_reg); // apply unless user chose a tail via link/field
      }
    }).catch(function(){});
  }
  // Save the aircraft fleet to the signed-in user's profile (no-op when signed out). Called by the page on any fleet change.
  function pushFleet(f){ if(!USER||!f) return; SB.from('profiles').update({fleet:f, default_reg:(f.def||'')}).eq('id',USER.id).then(function(){}).catch(function(){}); }
  window.PW_saveFleet=function(f){ try{ pushFleet(f); }catch(e){} };
  function saveDefaultReg(){ if(!USER) return;
    var v=($('#pw-reg').value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    SB.from('profiles').update({default_reg:v}).eq('id',USER.id).then(function(r){
      if(r.error){msg(r.error.message);return;}
      PROFILE.default_reg=v; if(window.PW_setReg) window.PW_setReg(v,{force:true}); msg(v?('Default aircraft set to '+v):'Default aircraft cleared');
    });
  }
  function startRecovery(){ RECOVERY=true; var p=$('#pwacct'); if(p){ p.classList.add('open'); } render(); }
  function setNewPass(){
    var a=$('#pw-newpass').value, b=$('#pw-newpass2').value;
    if(!a||a.length<8){msg('Password must be at least 8 characters.');return;}
    if(a!==b){msg('Passwords don\'t match.');return;}
    msg('Updating…');
    SB.auth.updateUser({password:a}).then(function(r){
      if(r.error){msg(softErr(r.error.message));return;}
      RECOVERY=false; render(); msg('✓ Password updated — you\'re signed in.');
    });
  }

  function saveRoute(){
    if(!window.PW_getState){msg('page not ready');return;}
    var st=window.PW_getState(), nm=$('#pw-rname').value.trim()||st.route;
    if(!st.route){msg('No route to save');return;}
    SB.from('routes').insert({user_id:USER.id,name:nm,route:st.route,aircraft:st.aircraft||{}}).then(function(r){
      if(r.error){msg(r.error.message);} else {msg('Saved.'); $('#pw-rname').value=''; listRoutes();}});}
  function listRoutes(){
    SB.from('routes').select('*').order('updated_at',{ascending:false}).then(function(r){
      var box=$('#pw-list'); if(!box) return;
      if(r.error){box.innerHTML='<span class="muted">'+esc(r.error.message)+'</span>';return;}
      if(!r.data.length){box.innerHTML='<span class="muted">No saved routes yet.</span>';return;}
      box.innerHTML=r.data.map(function(row){return '<div class="row"><a data-load="'+row.id+'" title="'+esc(row.route)+'">'+esc(row.name)+'</a>'+
        '<span><a data-del="'+row.id+'" class="link">✕</a></span></div>';}).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-load]'),function(a){a.onclick=function(){
        var row=r.data.filter(function(x){return x.id==a.getAttribute('data-load');})[0]; if(!row) return;
        if(window.PW_applyState){ window.PW_applyState(row); msg('Loaded '+row.name); }
        else { location.href='/wx/?route='+encodeURIComponent(row.route||''); } // no map on this page → open the map with it
      };});
      Array.prototype.forEach.call(box.querySelectorAll('[data-del]'),function(a){a.onclick=function(){SB.from('routes').delete().eq('id',a.getAttribute('data-del')).then(function(){listRoutes();});};});
    });}

  function uuid(){ try{ if(window.crypto&&crypto.randomUUID) return crypto.randomUUID(); }catch(e){}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8);return v.toString(16);}); }
  function clientId(){ try{ var k='pw_cid', v=localStorage.getItem(k); if(!v){ v=uuid(); localStorage.setItem(k,v); } return v; }catch(e){ return null; } }

  function boot(){
    style();
    // Use an in-page trigger if the page provides one (#pw-acct-slot); else float a pill top-right.
    var slot=document.getElementById('pw-acct-slot');
    if(slot){ TRIG=slot; TRIG.style.cursor='pointer'; }
    else { TRIG=document.createElement('button'); TRIG.id='pwacct-btn'; document.body.appendChild(TRIG); }
    TRIG.onclick=toggle;
    var pan=document.createElement('div'); pan.id='pwacct'; document.body.appendChild(pan);
    var pwClose=document.createElement('button'); pwClose.id='pwacct-close'; pwClose.type='button'; pwClose.setAttribute('aria-label','Close'); pwClose.textContent='\u2715'; pwClose.style.cssText='position:fixed;right:18px;top:62px;z-index:3001;background:none;border:none;color:#6b7889;font-size:16px;line-height:1;cursor:pointer;display:none;padding:2px 6px;width:auto'; document.body.appendChild(pwClose); pwClose.onclick=function(){ pan.classList.remove('open'); pwClose.style.display='none'; };
    window.PW_toggleAccount=toggle;
    // Quick-save the current route to the account (used by the briefing's "Save Route" button). Returns Promise<{ok,error,name}>.
    window.PW_saveRoute=function(){ return new Promise(function(res){
      if(!SB||!USER){ if(pan&&!pan.classList.contains('open')) toggle(); res({ok:false,error:'signin'}); return; }
      if(!window.PW_getState){ res({ok:false,error:'notready'}); return; }
      var st=window.PW_getState(); if(!st||!st.route){ res({ok:false,error:'noroute'}); return; }
      var nm=(window.prompt('Name this route:', st.route)||'').trim(); if(!nm){ res({ok:false,error:'cancel'}); return; }
      SB.from('routes').insert({user_id:USER.id,name:nm,route:st.route,aircraft:st.aircraft||{}}).then(function(r){
        if(r.error){ res({ok:false,error:r.error.message}); } else { if(pan.classList.contains('open')) listRoutes(); res({ok:true,name:nm}); } });
    }); };
    // Log a completed briefing + its metered usage to Supabase (works for anon via a per-device client_id).
    // The briefing_id is generated client-side so no RETURNING/SELECT is needed (anon has insert-only rights).
    // payload: { route_text, waypoint_count, aircraft_reg, usage: { <service_code>: quantity, ... } }
    window.PW_logBriefing=function(payload){ return new Promise(function(res){
      try{
        if(!SB){ res({ok:false,error:'offline'}); return; }
        payload=payload||{};
        var bid=uuid();
        var brief={ briefing_id: bid, user_id: USER?USER.id:null, client_id: clientId(),
          route_text: payload.route_text||null, waypoint_count: payload.waypoint_count||null, aircraft_reg: payload.aircraft_reg||null };
        SB.from('briefing').insert(brief).then(function(r){
          if(r.error){ res({ok:false,error:r.error.message}); return; }
          var u=payload.usage||{}, want=Object.keys(u).filter(function(c){ return isFinite(+u[c]) && +u[c]>0; });
          if(!want.length){ res({ok:true,briefing_id:bid,usage:0}); return; }
          SB.from('cost_service').select('service_id,code').then(function(sr){   // anon may read the meter list
            var map={}; (sr.data||[]).forEach(function(s){ map[s.code]=s.service_id; });
            var ins=want.filter(function(c){ return map[c]!=null; }).map(function(c){ return {briefing_id:bid,service_id:map[c],quantity:+u[c]}; });
            if(!ins.length){ res({ok:true,briefing_id:bid,usage:0}); return; }
            SB.from('briefing_usage').insert(ins).then(function(ur){ res({ok:!ur.error,briefing_id:bid,usage:ins.length,error:ur.error&&ur.error.message}); });
          });
        });
      }catch(e){ res({ok:false,error:String(e.message||e)}); }
    }); };
    // A password-recovery link lands here with type=recovery in the URL (hash or query).
    var wantRecovery=(location.hash+' '+location.search).indexOf('type=recovery')>=0;
    fetch('/wx/wx-config.json',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      cfg=j||{};
      if(!cfg.supabaseUrl||!window.supabase){ TRIG.textContent='👤 Account (offline)'; return; }
      SB=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseKey);
      SB.auth.getUser().then(function(r){ USER=r.data?r.data.user:null; upd(); if(wantRecovery){ startRecovery(); } else { render(); } if(window.PW_onAuth) window.PW_onAuth(!!USER); if(USER) fetchProfile(); });
      SB.auth.onAuthStateChange(function(ev,sess){ USER=sess?sess.user:null; upd(); if(ev==='PASSWORD_RECOVERY'){ startRecovery(); } else if(!RECOVERY){ render(); } if(window.PW_onAuth) window.PW_onAuth(!!USER); if(USER) fetchProfile(); });
    }).catch(function(){ TRIG.textContent='👤 Account (offline)'; });
  }
  function upd(){ if(TRIG) TRIG.textContent= USER ? ('◉ '+((USER.user_metadata&&USER.user_metadata.name||USER.email).split('@')[0])) : '👤 Sign in'; }
  if(document.readyState!=='loading') boot(); else document.addEventListener('DOMContentLoaded',boot);
})();
