/* Vendored from ee_design_review/assets/auth.js (the Signoff engine). Do not edit here: re-copy with tools/sync_vendor.py. */
/* Sign in with GitHub for the Signoff suite (an engine file; the plan is signoff/docs/sign-in.md).

   A GitHub App's web flow with PKCE. The page sends the person to github.com, GitHub handles the
   password, 2FA, and passkeys, and sends them back to signoff/auth.html with a one-time code. The
   signoff-auth Worker swaps that code for tokens, because the swap needs the app's client secret and
   GitHub's token endpoint has no CORS.

   Storage (localStorage, shared by every tool on this origin):
     signoff.token          the current access token. Every tool already reads this key.
     signoff.auth           {v, refresh, expiresAt, refreshExpiresAt, name}: present only for a sign-in,
                            never for a pasted token. The refresh token is the most sensitive value here.
     signoff.login          the signed-in GitHub login. It changes only on sign-in or sign-out, so pages
                            watch this key, not signoff.token, which changes at every refresh. The
                            engine's model.tokenTag reads it too, so a refresh isn't a new person.
   sessionStorage:
     signoff.auth.pending   {state, verifier, returnTo, redirect} between leaving for GitHub and coming back.

   Refresh: access tokens last 8 hours. token() refreshes an hour ahead. A refresh token works once, so
   every refresh runs inside one navigator.locks lock across every tab of every tool, and re-reads
   storage inside the lock in case another tab already did it.

   Synced into ME and FW with the engine, vendored into PL, Fabcheck, Loom, Flasher, and the hub.
   Plain script, no modules: window.SignoffAuth. */
(function () {
  'use strict';

  // One GitHub App and Worker per site. Each Worker's origin must be in the page's CSP connect-src.
  // A site not listed here keeps pasting tokens.
  // Production: the Dovetail Signoff app, for the hosted pages. Dev: Dovetail Signoff App, localhost only.
  var PROD = { clientId: 'Iv23li2MtbpspvneopRN', worker: 'https://signoff-auth.misty-dawn-b371.workers.dev' };
  var DEV = { clientId: 'Iv23liRCoaHFv0aMl16i', worker: 'https://signoff-auth-dev.misty-dawn-b371.workers.dev' };
  var APPS = {
    'https://chrismessick-dpd.github.io': PROD,
    'http://localhost:8774': DEV,
    'http://localhost:8771': DEV,
  };
  var CALLBACK = '/signoff/auth.html';
  var EARLY = 60 * 60 * 1000;          // refresh when less than an hour is left
  var LOCK = 'signoff.auth';
  var K = { token: 'signoff.token', auth: 'signoff.auth', login: 'signoff.login', pending: 'signoff.auth.pending' };
  var stats = { refreshes: 0 };       // Worker refresh calls made by this page (tests and the lab)

  function app() { return APPS[location.origin] || null; }

  // ── storage, never throwing (private windows can block it) ──
  function get(store, k) { try { return store.getItem(k); } catch (e) { return null; } }
  function set(store, k, v) { try { if (v === null || v === undefined) store.removeItem(k); else store.setItem(k, v); } catch (e) { /* blocked */ } }
  function getJson(store, k) { try { return JSON.parse(get(store, k) || 'null'); } catch (e) { return null; } }

  function readAuth() {
    var a = getJson(localStorage, K.auth);
    return a && a.v === 1 && typeof a.refresh === 'string' ? a : null;
  }
  function currentToken() { return get(sessionStorage, K.token) || get(localStorage, K.token) || ''; }

  function save(t, now, login, name) {
    set(sessionStorage, K.token, null);   // a session-only pasted token must not shadow the new one
    set(localStorage, K.token, t.access_token);
    var old = readAuth() || {};
    set(localStorage, K.auth, JSON.stringify({
      v: 1,
      refresh: t.refresh_token,
      expiresAt: now + (Number(t.expires_in) || 28800) * 1000,
      refreshExpiresAt: now + (Number(t.refresh_token_expires_in) || 15897600) * 1000,
      name: name !== undefined ? name : (old.name || ''),
    }));
    if (login !== undefined) set(localStorage, K.login, login);
  }
  function clear() {
    set(localStorage, K.token, null); set(sessionStorage, K.token, null);
    set(localStorage, K.auth, null); set(localStorage, K.login, null);
    set(localStorage, 'signoff.auth.previous', null);   // left by the 2026-11-10 sign-in lab
  }

  // ── PKCE ──
  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function random(n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return b64url(b); }
  function challenge(verifier) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (d) { return b64url(new Uint8Array(d)); });
  }

  // Only same-origin paths come back from GitHub's round trip.
  function safeReturn(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin ? u.pathname + u.search + u.hash : '/';
    } catch (e) { return '/'; }
  }

  function failure(message, code) { var e = new Error(message); e.code = code; return e; }

  function worker(route, body) {
    var a = app();
    if (!a) return Promise.reject(failure('Sign in with GitHub isn’t set up for ' + location.origin + '.', 'not_set_up'));
    return fetch(a.worker + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
      .catch(function () { throw failure('The sign-in service can’t be reached. Check your connection and try again.', 'unreachable'); })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || data.error) throw failure(data.error_description || data.error || ('The sign-in service answered ' + res.status + '.'), data.error || ('http_' + res.status));
          return data;
        });
      });
  }

  function githubUser(token) {
    return fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, cache: 'no-store' })
      .catch(function () { throw failure('GitHub can’t be reached. Check your connection and try again.', 'unreachable'); })
      .then(function (res) {
        if (!res.ok) throw failure('GitHub didn’t accept the new sign-in (' + res.status + '). Try again.', 'http_' + res.status);
        return res.json();
      })
      .then(function (u) {
        if (!u || !u.login) throw failure('GitHub didn’t say who signed in. Try again.', 'no_login');
        return u;
      });
  }

  // ── sign in ──
  function signIn(returnTo) {
    var a = app();
    if (!a) return Promise.reject(failure('Sign in with GitHub isn’t set up for ' + location.origin + '.', 'not_set_up'));
    var state = random(24), verifier = random(48);
    var redirect = location.origin + CALLBACK;
    return challenge(verifier).then(function (ch) {
      set(sessionStorage, K.pending, JSON.stringify({ state: state, verifier: verifier, returnTo: safeReturn(returnTo || location.href), redirect: redirect }));
      var q = new URLSearchParams({ client_id: a.clientId, redirect_uri: redirect, state: state, code_challenge: ch, code_challenge_method: 'S256' });
      location.assign('https://github.com/login/oauth/authorize?' + q.toString());
    });
  }

  // On auth.html: finish the round trip. Resolves {login, returnTo}; rejects with a message to show.
  // Nothing is stored until GitHub has said who signed in, so the tokens and the login land together.
  function finish() {
    var q = new URLSearchParams(location.search);
    var pending = getJson(sessionStorage, K.pending);
    set(sessionStorage, K.pending, null);
    history.replaceState(null, '', location.pathname);   // the code never stays in the address bar or history
    if (q.get('error')) return Promise.reject(failure(q.get('error') === 'access_denied' ? 'Sign-in was cancelled on GitHub.' : (q.get('error_description') || q.get('error')), q.get('error')));
    if (!pending || !q.get('code')) return Promise.reject(failure('This sign-in link has expired or was opened in another tab. Start again from Sign in with GitHub.', 'no_pending'));
    if (q.get('state') !== pending.state) return Promise.reject(failure('This sign-in didn’t start in this browser tab, so it was refused. Start again.', 'bad_state'));
    var started = Date.now(), tokens;
    return worker('/exchange', { code: q.get('code'), code_verifier: pending.verifier, redirect_uri: pending.redirect }).then(function (t) {
      tokens = t;
      return githubUser(t.access_token);
    }).then(function (u) {
      return withLock(function () { save(tokens, started, u.login.toLowerCase(), u.name || ''); }).then(function () {
        return { login: u.login, name: u.name || '', returnTo: safeReturn(pending.returnTo) };
      });
    });
  }

  // ── refresh ──
  function withLock(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) return navigator.locks.request(LOCK, fn);
    return Promise.resolve().then(fn);   // no Web Locks: tabs that refresh at the same instant can collide
  }

  // Refresh if due, or if `failed` (a token that just got a 401) is still the stored one.
  // Resolves the token to use, or '' when GitHub has ended the sign-in (the page is then signed out).
  function refresh(failed) {
    return withLock(function () {
      var a = readAuth();
      if (!a) return currentToken();
      var now = Date.now(), tok = currentToken();
      var due = a.expiresAt - now < EARLY;
      if (!due && !(failed && failed === tok)) return tok;    // another tab already refreshed
      if (a.refreshExpiresAt <= now) { clear(); return ''; }
      stats.refreshes++;
      return worker('/refresh', { refresh_token: a.refresh }).then(function (t) {
        save(t, now);
        return t.access_token;
      }, function (err) {
        // A refresh token GitHub refuses is dead: signed out, so pages ask again.
        if (err.code === 'bad_refresh_token' || err.code === 'unauthorized') { clear(); return ''; }
        throw err;   // GitHub or the Worker unreachable: keep everything, and try again later
      });
    });
  }

  // The token to use now, refreshed first if it's due. A pasted token comes back as it is.
  // An early refresh that can't reach the Worker or GitHub falls back to the current token while it
  // still has time left; once it has really expired, the failure comes through.
  function token() {
    var a = readAuth();
    if (!a || a.expiresAt - Date.now() >= EARLY) return Promise.resolve(currentToken());
    return refresh().catch(function (err) {
      var now = readAuth();
      if (now && now.expiresAt > Date.now() && currentToken()) return currentToken();
      throw err;
    });
  }

  // Whether `tok` came from this sign-in (any of its access tokens, current or replaced), so callers
  // should get the current one from token() and refresh on a 401. A pasted token is never ours.
  function owns(tok) { return !!readAuth() && /^ghu_/.test(String(tok || '')); }

  // ── sign out: GitHub forgets the sign-in, and this browser forgets the tokens ──
  // Resolves once both are done (a page that reloads afterward must wait, or the revoke is cut off).
  function signOut() {
    var tok = currentToken(), signedIn = !!readAuth();
    var revoke = signedIn ? worker('/revoke', { access_token: tok }).catch(function () { /* signed out here anyway */ }) : Promise.resolve();
    return revoke.then(function () { clear(); });
  }

  function status() {
    var a = readAuth();
    return {
      available: !!app(),
      signedIn: !!a,
      login: (a && get(localStorage, K.login)) || '',
      name: (a && a.name) || '',
      pasted: !a && !!currentToken(),
      expiresAt: a ? a.expiresAt : 0,
      refreshExpiresAt: a ? a.refreshExpiresAt : 0,
    };
  }

  window.SignoffAuth = { signIn: signIn, finish: finish, token: token, refresh: refresh, owns: owns, signOut: signOut, status: status, stats: stats, keys: K };
})();
