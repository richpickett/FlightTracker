/* Personal Wings Suite — per-app usage ping.
   Each app calls pwPing(SB, '<app>') once on load / after sign-in. Best-effort: never blocks
   the UI and never throws. Writes app_usage.last_seen (+hits) for the signed-in user via the
   pw_ping RPC (atomic increment); falls back to a plain upsert if the RPC isn't present yet.
   app ids: 'ft' (Flight Tracker), 'logbook' (Logbook Atlas), 'track' (Track Atlas).
   Usage:  pwPing(SB, 'logbook');   // fire-and-forget
*/
(function (w) {
  var sent = {};   // de-dupe within a page session (one ping per app per load)

  async function pwPing(SB, app) {
    try {
      if (!SB || !app || sent[app]) return;
      var s = await SB.auth.getSession();
      var u = s && s.data && s.data.session && s.data.session.user;
      if (!u) return;                       // signed-out: nothing to record
      sent[app] = true;
      // Preferred: atomic RPC (increments hits, stamps last_seen).
      var r = await SB.rpc("pw_ping", { p_app: app });
      if (r && r.error) {                   // RPC missing/blocked -> best-effort upsert
        await SB.from("app_usage")
          .upsert({ user_id: u.id, app: app, last_seen: new Date().toISOString() },
                  { onConflict: "user_id,app" });
      }
    } catch (e) { /* usage tracking is non-critical; swallow */ }
  }

  w.pwPing = pwPing;
})(window);
