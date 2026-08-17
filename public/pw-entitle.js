/* Personal Wings — STANDALONE FlightTracker: all features FREE (no gating).
   Drop-in replacement for the Suite's pw-entitle.js. Everything unlocked; no lock badges,
   no upgrade prompts, no trial banner. Same Supabase (auth/profiles/routes) — just no premium gate.
   When folding back into the Suite, restore the Suite's pw-entitle.js. */
(function (w) {
  var YES = function(){ return Promise.resolve(true); };
  var MAP = function(){ return Promise.resolve({ suite:{tier:'premium',premium:true}, analysis:{tier:'premium',premium:true} }); };
  w.pwCan          = function(){ return YES(); };                 // every feature allowed
  w.pwScopePremium = function(){ return YES(); };                 // premium everywhere -> pwMarkFree clears .pw-free (no badges)
  w.pwEntitledMap  = function(){ return MAP(); };
  w.pwEntitled     = function(){ return Promise.resolve({ tier:'premium', premium:true }); };
  w.pwGatePremium  = function(SB,onP){ if(onP) onP({tier:'premium',premium:true}); return Promise.resolve({tier:'premium',premium:true}); };
  w.pwStartTrial   = function(){ return Promise.resolve('already_premium'); };
  w.pwTrialBanner  = function(){};                                // no reminder in the free build
  w.pwEntitledCache= function(){ return { suite:{premium:true} }; };
  w.PW_FEATURES    = {};
})(window);
