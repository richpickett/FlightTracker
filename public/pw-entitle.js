/* Personal Wings Suite — entitlement gate v2 (per-scope, feature-mapped).
   Reads the signed-in user's entitlement rows from the shared `entitlement` table and gates
   features by scope. Any suite app loads this and asks pwCan() before showing a premium feature.

   Scopes:  'suite'    = full Flight Tracker + Track Atlas + Logbook Atlas (bundle, or 30-day trial)
            'analysis' = Aircraft Logbook Analysis (separate three-plan product)

   Usage:
     if (await pwCan(SB,'ft.food_search')) { ...enable food search... }
     const r = await pwStartTrial(SB);   // 'ok' | 'trial_already_used' | 'already_premium' | 'signed-out'
     const m = await pwEntitledMap(SB);  // { suite:{premium,...}, analysis:{premium,...} }

   ── EDIT ME ── The free/paid split moves constantly; change it HERE, not in the schema.
   Each feature maps to the scope + tier it requires. Anything not listed is free by default.
*/
(function (w) {
  var FEATURES = {
    // Flight Tracker (suite)
    "ft.briefing_ai_notams": { scope: "suite", tier: "premium" },
    "ft.food_search":        { scope: "suite", tier: "premium" },
    "ft.closed_twy_rwy":     { scope: "suite", tier: "premium" },   // closed runway/taxiway diagram (briefing)
    "ft.share_html":         { scope: "suite", tier: "premium" },   // Share the live map (map)
    // Track Atlas (suite)
    "track.full_history":    { scope: "suite", tier: "premium" },
    // Logbook Atlas (suite)
    "logbook.full_history":  { scope: "suite", tier: "premium" },
    // Aircraft Logbook Analysis (separate product) — whole app is premium; free sees only the login/description.
    "analysis.app":          { scope: "analysis", tier: "premium" }
  };

  var cache = null;   // { suite:{...}, analysis:{...} } for this page session

  function scopePremium(e) {
    return !!e && e.tier === "premium" && (!e.period_end || new Date(e.period_end) > new Date());
  }

  // Load every entitlement row for the signed-in user, keyed by scope, with a derived .premium.
  async function pwEntitledMap(SB, force) {
    try {
      if (cache && !force) return cache;
      if (!SB) return {};                         // no client yet — don't cache, let a later call retry
      var s = await SB.auth.getSession();
      var u = s && s.data && s.data.session && s.data.session.user;
      if (!u) return {};                          // signed-out — don't cache (avoids locking to free before auth settles)
      var r = await SB.from("entitlement").select("scope,tier,status,plan,period_end,trial_used").eq("user_id", u.id);
      if (r && r.error) return {};                // transient read error — don't cache a false 'free'
      var map = {};
      (r && r.data || []).forEach(function (e) {
        e.premium = scopePremium(e);
        map[e.scope || "suite"] = e;
      });
      return (cache = map);                        // cache only a clean, authenticated read
    } catch (err) { return {}; }
  }

  // True if the signed-in user may use a feature. Unknown feature keys default to allowed (free).
  async function pwCan(SB, feature) {
    var f = FEATURES[feature];
    if (!f) return true;                       // not gated
    if (f.tier !== "premium") return true;     // explicitly free
    var m = await pwEntitledMap(SB);
    return scopePremium(m[f.scope]);
  }

  // Convenience: is a whole scope premium right now?
  async function pwScopePremium(SB, scope) {
    var m = await pwEntitledMap(SB);
    return scopePremium(m[scope || "suite"]);
  }

  // Start the one-per-account no-card 30-day suite trial. Returns the RPC verdict string.
  async function pwStartTrial(SB) {
    try {
      if (!SB) return "no-client";
      var r = await SB.rpc("pw_start_trial", { p_days: 30 });
      if (r && r.error) return "error";
      cache = null;                            // force a re-read so the UI reflects the new trial
      return (r && r.data) || "ok";
    } catch (err) { return "error"; }
  }

  // One trial reminder: a dismissible bottom banner shown only near expiry (≤2 days) or once lapsed.
  // Dismissal persists per trial period. "Subscribe" link appears only once window.PW_SUBSCRIBE_URL is set.
  function pwBannerDismissed(key){ try{ return localStorage.getItem("pw_trial_dismiss") === key; }catch(e){ return false; } }
  function pwShowBanner(msg, key){
    if (typeof document === "undefined" || document.getElementById("pw-trial-banner")) return;
    var sub = window.PW_SUBSCRIBE_URL ? ' <a href="' + window.PW_SUBSCRIBE_URL + '" style="color:#0b3d91;text-decoration:underline;font-weight:700">Subscribe</a>' : "";
    var b = document.createElement("div"); b.id = "pw-trial-banner";
    b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:100001;background:#fff4e0;color:#7a4e0a;border-top:1px solid #f0d8a8;font:600 13px system-ui;padding:10px 46px 10px 16px;text-align:center;box-shadow:0 -2px 10px rgba(11,61,145,.10)";
    b.innerHTML = "🔒 " + msg + sub + '<button aria-label="Dismiss" style="position:absolute;right:12px;top:6px;border:none;background:transparent;color:#7a4e0a;font-size:20px;cursor:pointer;line-height:1">×</button>';
    b.querySelector("button").onclick = function(){ b.remove(); try{ localStorage.setItem("pw_trial_dismiss", key); }catch(e){} };
    (document.body || document.documentElement).appendChild(b);
  }
  async function pwTrialBanner(SB){
    try{
      var m = await pwEntitledMap(SB); var e = m.suite; if (!e) return;
      var now = Date.now(), end = e.period_end ? new Date(e.period_end).getTime() : 0;
      var msg = null, key = null;
      if (e.premium && e.status === "TRIAL" && end){
        var days = Math.ceil((end - now) / 86400000);
        if (days <= 2){ msg = "Your Premium trial ends " + (days <= 0 ? "today" : ("in " + days + " day" + (days === 1 ? "" : "s"))) + " — one plan keeps AI NOTAMs, food search, closed RWY/TWY diagrams, map sharing &amp; Atlas history."; key = "end:" + e.period_end; }
      } else if (!e.premium && e.trial_used && e.status === "TRIAL" && end && end < now){
        msg = "Your Premium trial has ended — subscribe to restore AI NOTAMs, food search, closed RWY/TWY diagrams, map sharing &amp; full Atlas history."; key = "exp:" + e.period_end;
      }
      if (msg && !pwBannerDismissed(key)) pwShowBanner(msg, key);
    }catch(err){}
  }

  // Back-compat: the original single-scope gate now points at 'suite'.
  async function pwEntitled(SB) {
    var m = await pwEntitledMap(SB);
    var e = m.suite || {};
    return { tier: e.premium ? "premium" : "free", premium: !!e.premium,
             plan: e.plan || null, status: e.status || null, period_end: e.period_end || null,
             trial_used: !!e.trial_used };
  }
  async function pwGatePremium(SB, onPremium, onFree) {
    var ent = await pwEntitled(SB);
    if (ent.premium) { if (onPremium) onPremium(ent); } else if (onFree) onFree(ent);
    return ent;
  }

  w.PW_FEATURES     = FEATURES;
  w.pwEntitledMap   = pwEntitledMap;
  w.pwCan           = pwCan;
  w.pwScopePremium  = pwScopePremium;
  w.pwStartTrial    = pwStartTrial;
  w.pwTrialBanner   = pwTrialBanner;
  w.pwEntitled      = pwEntitled;
  w.pwGatePremium   = pwGatePremium;
  w.pwEntitledCache = function () { return cache; };
})(window);
