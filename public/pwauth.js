/* Personal Wings — accounts + saved routes widget.
   Requires @supabase/supabase-js (v2) loaded before this file, and a page that
   defines window.PW_getState() -> {route, aircraft} and window.PW_applyState(obj). */
(function(){
  var SB=null, USER=null, cfg={}, TRIG=null;
  function $(s,r){return (r||document).querySelector(s);}
  function esc(s){return (s||'').replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];});}
  function style(){var s=document.createElement('style');s.textContent=
   '#pwacct-btn{position:fixed;right:12px;top:12px;z-index:3000;background:#0b3d91;color:#fff;border:none;border-radius:20px;padding:8px 13px;font:600 13px system-ui;cursor:pointer;box-shadow:0 2px 8px #0006}'+
   '#pwacct{position:fixed;right:12px;top:56px;z-index:3000;width:300px;max-width:92vw;background:#0f1720;color:#e8eef6;border:1px solid #26313f;border-radius:12px;padding:12px;box-shadow:0 10px 34px #0008;font:13px system-ui;display:none}'+
   '#pwacct.open{display:block} #pwacct h4{margin:0 0 8px;font-size:14px;color:#9bd1ff}'+
   '#pwacct input{width:100%;box-sizing:border-box;margin:4px 0;background:#0e1723;border:1px solid #26313f;color:#e8eef6;border-radius:7px;padding:8px}'+
   '#pwacct button{background:#0b3d91;color:#fff;border:none;border-radius:7px;padding:7px 10px;font:600 13px system-ui;cursor:pointer;margin:4px 4px 0 0}'+
   '#pwacct button.sec{background:#1b2735;color:#cfe0f7} #pwacct .row{display:flex;justify-content:space-between;align-items:center;gap:6px;border-bottom:1px solid #1a2430;padding:5px 0}'+
   '#pwacct .row a{color:#9bd1ff;cursor:pointer;text-decoration:none;font-weight:600} #pwacct .msg{color:#ffb14a;font-size:12px;margin:5px 0;min-height:14px}'+
   '#pwacct .muted{color:#8ea0b5;font-size:12px} #pwacct a.link{color:#9bd1ff;cursor:pointer}';
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
        '<div style="margin-top:8px"><a class="link" id="pw-out">Sign out</a></div>';
      $('#pw-who').textContent=(USER.user_metadata&&USER.user_metadata.name?USER.user_metadata.name+' · ':'')+USER.email;
      $('#pw-save').onclick=saveRoute; $('#pw-out').onclick=signOut; listRoutes();
    }
  }
  function toggle(){var p=$('#pwacct'); p.classList.toggle('open'); if(p.classList.contains('open')) render();}

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
  function signOut(){ SB.auth.signOut(); }

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
      Array.prototype.forEach.call(box.querySelectorAll('[data-load]'),function(a){a.onclick=function(){var row=r.data.filter(function(x){return x.id==a.getAttribute('data-load');})[0]; if(row&&window.PW_applyState) window.PW_applyState(row); msg('Loaded '+row.name);};});
      Array.prototype.forEach.call(box.querySelectorAll('[data-del]'),function(a){a.onclick=function(){SB.from('routes').delete().eq('id',a.getAttribute('data-del')).then(function(){listRoutes();});};});
    });}

  function boot(){
    style();
    // Use an in-page trigger if the page provides one (#pw-acct-slot); else float a pill top-right.
    var slot=document.getElementById('pw-acct-slot');
    if(slot){ TRIG=slot; TRIG.style.cursor='pointer'; }
    else { TRIG=document.createElement('button'); TRIG.id='pwacct-btn'; document.body.appendChild(TRIG); }
    TRIG.onclick=toggle;
    var pan=document.createElement('div'); pan.id='pwacct'; document.body.appendChild(pan);
    window.PW_toggleAccount=toggle;
    fetch('/wx/wx-config.json',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      cfg=j||{};
      if(!cfg.supabaseUrl||!window.supabase){ TRIG.textContent='👤 Account (offline)'; return; }
      SB=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseKey);
      SB.auth.getUser().then(function(r){ USER=r.data?r.data.user:null; upd(); render(); });
      SB.auth.onAuthStateChange(function(_e,sess){ USER=sess?sess.user:null; upd(); render(); });
    }).catch(function(){ TRIG.textContent='👤 Account (offline)'; });
  }
  function upd(){ if(TRIG) TRIG.textContent= USER ? ('◉ '+((USER.user_metadata&&USER.user_metadata.name||USER.email).split('@')[0])) : '👤 Sign in'; }
  if(document.readyState!=='loading') boot(); else document.addEventListener('DOMContentLoaded',boot);
})();
