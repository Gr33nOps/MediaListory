/** Shared frontend helpers: escaping, auth token, API, a11y modals/cards */
(function (global) {
  // ── Site config ────────────────────────────────────────────────────
  // To enable Google Analytics 4, put your measurement ID here (e.g. 'G-ABC123').
  // Leave empty to disable analytics entirely. Honors Do Not Track.
  global.MGL_GA_ID = global.MGL_GA_ID || '';
  // Sentry error tracking. This is the frontend DSN, which is public by design
  // (it ships to every browser). Set to '' to disable.
  global.MGL_SENTRY_DSN = global.MGL_SENTRY_DSN ||
    'https://a031d4f07ac27ac8fd0107e89d564f9a@o4511927699439616.ingest.de.sentry.io/4512013714128976';
  // The frontend is hosted on Vercel (instant static) and talks to the API on
  // Render cross-origin. Resolution order:
  //   1. window.MGL_API_BASE, if you set it explicitly (escape hatch).
  //   2. localhost / *.onrender.com → same-origin `/api` (local dev, or the
  //      Render service still self-serving the app as a fallback).
  //   3. anything else (Vercel domain, custom domain) → the Render API origin.
  // Keep this host in sync with the deployed backend (also used by the "waking
  // the server" ping below).
  var API_ORIGIN = 'https://medialistory.onrender.com';
  function resolveApiBase() {
    if (typeof global.MGL_API_BASE === 'string' && global.MGL_API_BASE) {
      return global.MGL_API_BASE.replace(/\/$/, '');
    }
    var host = (location.hostname || '').toLowerCase();
    var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === '[::1]';
    var isBackendHost = /(^|\.)onrender\.com$/.test(host);
    if (isLocal || isBackendHost) return '/api';
    return API_ORIGIN + '/api';
  }
  var API_BASE = resolveApiBase();
  var modalState = null;

  // ── Analytics (opt-in) ─────────────────────────────────────────────
  // No-op until a Google Analytics 4 measurement ID is provided, either via
  // `window.MGL_GA_ID = 'G-XXXXXXXXXX'` before this script, or a
  // <meta name="ga-id" content="G-XXXXXXXXXX"> tag. Honors Do Not Track.
  function initAnalytics() {
    var id = global.MGL_GA_ID;
    if (!id) {
      var m = document.querySelector('meta[name="ga-id"]');
      if (m) id = m.getAttribute('content');
    }
    if (!id || !/^G-[A-Z0-9]+$/i.test(id)) return; // not configured
    if (navigator.doNotTrack === '1' || global.doNotTrack === '1') return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
    global.dataLayer = global.dataLayer || [];
    function gtag() { global.dataLayer.push(arguments); }
    global.gtag = gtag;
    gtag('js', new Date());
    gtag('config', id, { anonymize_ip: true });
  }

  // ── Theme (dark default, opt-in light) ────────────────────────────────
  // The saved theme is applied to <html data-theme> by a tiny inline script in
  // each page's <head> (before paint, so no flash). These helpers drive the
  // nav toggle and keep localStorage in sync.
  var SUN_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function currentTheme() {
    try { return localStorage.getItem('theme') === 'light' ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }
  function paintThemeBtn(btn, theme) {
    // Show the icon for the mode you'd switch TO.
    btn.innerHTML = theme === 'light' ? MOON_SVG : SUN_SVG;
    btn.setAttribute('title', theme === 'light' ? 'Switch to dark' : 'Switch to light');
  }
  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem('theme', theme); } catch (e) {}
    var btn = document.getElementById('navThemeBtn');
    if (btn) paintThemeBtn(btn, theme);
  }

  // ── Sentry error tracking (opt-in) ─────────────────────────────────────
  // No-op until a DSN is configured (global.MGL_SENTRY_DSN or a
  // <meta name="sentry-dsn">). Uses Sentry's Loader Script so we never pin an
  // SDK version, buffers errors from the moment it loads, and scrubs anything
  // sensitive before an event leaves the browser.
  function initSentry() {
    var dsn = global.MGL_SENTRY_DSN;
    if (!dsn) {
      var m = document.querySelector('meta[name="sentry-dsn"]');
      if (m) dsn = m.getAttribute('content');
    }
    if (!dsn || !/^https:\/\/[^@\s]+@[^/\s]+\/\d+/.test(dsn)) return; // not configured / malformed
    var publicKey, ingestHost;
    try {
      publicKey = dsn.split('//')[1].split('@')[0];
      ingestHost = dsn.split('@')[1].split('/')[0];
    } catch (_) { return; }
    if (!publicKey) return;

    // Region-aware loader host (e.g. an ...ingest.de.sentry.io DSN loads from
    // js-de.sentry-cdn.com, not the US default).
    var regionMatch = /\.ingest\.([a-z0-9-]+)\.sentry\.io$/i.exec(ingestHost || '');
    var region = regionMatch ? regionMatch[1] : '';
    var cdnHost = (region && region !== 'us') ? ('js-' + region + '.sentry-cdn.com') : 'js.sentry-cdn.com';

    var isLocal = /^(localhost$|127\.|0\.0\.0\.0$|\[?::1)/.test(location.hostname);

    // Configure BEFORE the SDK loads; the loader calls sentryOnLoad instead of
    // auto-init, so this init is the single source of truth.
    global.sentryOnLoad = function () {
      var S = global.Sentry;
      if (!S || typeof S.init !== 'function') return;
      var user = (typeof getStoredUser === 'function') ? getStoredUser() : null;
      // Session Replay masks all text/inputs/media so nothing sensitive is recorded.
      var integrations = [];
      try { if (S.replayIntegration) integrations.push(S.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true })); } catch (_) {}
      try { if (S.browserTracingIntegration) integrations.push(S.browserTracingIntegration()); } catch (_) {}
      S.init({
        dsn: dsn,
        environment: isLocal ? 'development' : 'production',
        release: 'medialistory@' + (document.documentElement.getAttribute('data-build') || 'web'),
        sendDefaultPii: false,
        integrations: integrations,
        tracesSampleRate: isLocal ? 0 : 0.1,
        tracePropagationTargets: [location.origin, /\/api\//],
        replaysSessionSampleRate: isLocal ? 0 : 0.1,
        replaysOnErrorSampleRate: isLocal ? 0 : 1.0,
        // Benign / expected noise we never want to page on.
        ignoreErrors: [
          'ResizeObserver loop', 'Non-Error promise rejection captured',
          'AbortError', 'The operation was aborted', 'The user aborted a request',
          'Load failed', 'NetworkError when attempting to fetch resource',
          'Failed to fetch'
        ],
        denyUrls: [/googletagmanager\.com/i, /google-analytics\.com/i, /translate\.goog/i, /extensions?\//i, /^chrome-extension:\/\//i],
        beforeSend: function (event, hint) {
          try {
            var err = hint && hint.originalException;
            var msg = (err && err.message) || event.message || '';
            // Guest-mode 401s and auth-check failures are expected, not bugs.
            if (/\b401\b|Unauthorized/i.test(msg)) return null;
            // Never let a session token or email leave the browser.
            if (event.request && event.request.headers) {
              delete event.request.headers.Authorization;
              delete event.request.headers.authorization;
              delete event.request.headers.Cookie;
            }
            var serialized = JSON.stringify(event);
            if (/authToken|Bearer\s|mgl_token/.test(serialized)) return null;
          } catch (_) {}
          return event;
        }
      });
      var pageTag = (document.body && document.body.getAttribute('data-page')) || location.pathname;
      S.setTag('page', pageTag);
      if (user && user.id) S.setUser({ id: String(user.id) }); // id only - no email/PII
    };

    var s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = 'https://' + cdnHost + '/' + encodeURIComponent(publicKey) + '.min.js';
    s.setAttribute('data-lazy', 'no'); // load the SDK eagerly, not on first error
    document.head.appendChild(s);
  }

  function apiIsCrossOrigin() {
    if (!API_BASE || API_BASE.charAt(0) === '/') return false;
    try {
      return new URL(API_BASE, location.href).origin !== location.origin;
    } catch (_) {
      return false;
    }
  }

  // ── Backend readiness (Render cold-start aware) ────────────────────────────
  // Render spins the free service down after inactivity; the first request after
  // idle can take up to ~50s while it boots. The static frontend renders
  // immediately from Vercel, so we track the API's readiness separately and show
  // an honest "waking the server" notice (mountBackendWake) instead of letting
  // data views sit on skeletons with no explanation.
  var backendReady = false;
  var _resolveReady;
  var backendReadyPromise = new Promise(function (r) { _resolveReady = r; });
  var pendingApiCalls = 0;      // in-flight apiFetch requests
  var apiFetchStarted = false;  // has this page made any real data call yet
  var _onApiActivity = null;    // mountBackendWake hooks this to react to data calls
  var _onApiIdle = null;        // ...and to react when the last one settles
  function markBackendReady() {
    if (backendReady) return;
    backendReady = true;
    // Remember the backend is awake so navigating between pages doesn't re-run
    // the cold-start panel while it's still warm (see mountBackendWake).
    try { localStorage.setItem('mgl:backendReadyAt', String(Date.now())); } catch (_) {}
    try { _resolveReady(true); } catch (_) {}
    try { document.dispatchEvent(new CustomEvent('mgl:backend-ready')); } catch (_) {}
  }
  function isBackendReady() { return backendReady; }
  // Resolve true once the backend answers, or false after capMs.
  function waitForBackend(capMs) {
    if (backendReady) return Promise.resolve(true);
    return Promise.race([
      backendReadyPromise.then(function () { return true; }),
      new Promise(function (r) { setTimeout(function () { r(false); }, capMs || 75000); })
    ]);
  }
  // Health lives at the API origin root (/health), not under /api.
  function healthUrl() {
    return (API_BASE.charAt(0) === '/') ? '/health' : API_BASE.replace(/\/api\/?$/, '') + '/health';
  }
  function pingHealth(timeoutMs) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, timeoutMs || 6000) : null;
    return fetch(healthUrl(), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return !!(r && r.ok); })
      .catch(function () { return false; })
      .then(function (ok) { if (timer) clearTimeout(timer); if (ok) markBackendReady(); return ok; });
  }

  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getToken() {
    return localStorage.getItem('authToken') || '';
  }

  /**
   * Restore session from Bearer JWT and/or httpOnly cookie.
   * Always send Authorization when localStorage has a token - cookie-only
   * restore fails on Vercel→Render rewrites and was wiping valid sessions
   * on every nav click.
   */
  async function ensureSession() {
    var had = getToken();
    try {
      var headers = {};
      if (had) headers.Authorization = 'Bearer ' + had;
      var res = await fetch(API_BASE + '/auth/session', {
        credentials: apiIsCrossOrigin() ? 'include' : 'same-origin',
        cache: 'no-store',
        headers: headers
      });
      if (res.ok) {
        var data = await res.json();
        if (data.token) localStorage.setItem('authToken', data.token);
        if (data.user) localStorage.setItem('currentUser', JSON.stringify(data.user));
        localStorage.setItem('lastActivity', Date.now().toString());
        return data;
      }
      // Only clear when the server rejected credentials we actually sent.
      // Keep localStorage on network/5xx so a flaky API does not log users out.
      if ((res.status === 401 || res.status === 403) && had) {
        clearSession();
        return null;
      }
      return had ? { token: had, user: getStoredUser() } : null;
    } catch (_) {
      return had ? { token: had, user: getStoredUser() } : null;
    }
  }

  function getStoredUser() {
    try {
      return JSON.parse(localStorage.getItem('currentUser') || 'null');
    } catch (_) {
      return null;
    }
  }

  /** Shared level curve for profile + userProfile. */
  function calculateLevel(gamesPlayed) {
    var played = Number(gamesPlayed) || 0;
    if (played <= 0) return 1;
    var level = 1;
    var gamesForNextLevel = 5;
    var totalGamesNeeded = 0;
    var increment = 5;
    while (totalGamesNeeded + gamesForNextLevel <= played) {
      totalGamesNeeded += gamesForNextLevel;
      level++;
      gamesForNextLevel += Math.floor(increment);
      increment += 0.5;
    }
    return level;
  }

  function authHeaders(extra) {
    var headers = Object.assign({}, extra || {});
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  function apiFetch(path, options) {
    var opts = options || {};
    opts.headers = authHeaders(opts.headers || {});
    // Cross-origin API (direct Render) needs include; same-origin keeps cookies simple.
    opts.credentials = opts.credentials || (apiIsCrossOrigin() ? 'include' : 'same-origin');
    opts.cache = opts.cache || 'no-store';
    var method = String(opts.method || 'GET').toUpperCase();
    // Only idempotent GETs are safe to auto-retry, and only when the caller isn't
    // managing its own abort signal (retrying a spent controller would fail).
    var canRetry = method === 'GET' && !opts.signal && apiIsCrossOrigin();
    // Track real data activity so the cold-start panel only appears on pages that
    // actually wait on the API (not static pages like About/Terms).
    apiFetchStarted = true;
    pendingApiCalls++;
    // Every data call drives the top bar, so there is always a visible sign
    // that something is loading, not only on full page navigations.
    if (pendingApiCalls === 1) startTopProgress();
    if (_onApiActivity) { try { _onApiActivity(); } catch (_) {} }
    var settled = false;
    function fin() {
      if (settled) return;
      settled = true;
      pendingApiCalls = Math.max(0, pendingApiCalls - 1);
      if (pendingApiCalls === 0) {
        finishTopProgress();
        if (_onApiIdle) { try { _onApiIdle(); } catch (_) {} }
      }
    }
    return fetch(API_BASE + path, opts).then(function (res) {
      if (res && res.ok) markBackendReady();
      fin();
      return res;
    }).catch(function (err) {
      // A network failure while the backend hasn't answered yet almost always
      // means Render is still cold. Wait for it to wake, then retry once so the
      // page recovers on its own instead of flashing an error. Keep the request
      // counted as pending while we wait, so the "starting" panel stays up.
      if (!canRetry || backendReady) { fin(); throw err; }
      return waitForBackend(75000).then(function (ready) {
        if (!ready) { fin(); throw err; }
        return fetch(API_BASE + path, opts).then(
          function (r) { fin(); return r; },
          function (e) { fin(); throw e; }
        );
      });
    });
  }

  function clearSession() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('lastActivity');
  }

  function getDensity() {
    return localStorage.getItem('uiDensity') === 'compact' ? 'compact' : 'comfortable';
  }

  function applyDensity(density) {
    var mode = density === 'compact' ? 'compact' : 'comfortable';
    localStorage.setItem('uiDensity', mode);
    document.documentElement.setAttribute('data-density', mode);
    return mode;
  }

  function initDensity() {
    applyDensity(getDensity());
  }

  function notify(message, type) {
    if (typeof toast === 'function') toast(message, type || 'info');
    else if (typeof global.toast === 'function') global.toast(message, type || 'info');
    else window.alert(message);
  }

  function ensureConfirmModal() {
    if (document.getElementById('mglConfirmModal')) return;
    var wrap = document.createElement('div');
    wrap.id = 'mglConfirmModal';
    wrap.className = 'modal mgl-confirm-modal';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="modal-content mgl-confirm-dialog" role="document">' +
        '<h3 id="mglConfirmTitle">Confirm</h3>' +
        '<p id="mglConfirmMessage" class="mgl-confirm-message"></p>' +
        '<div class="modal-actions mgl-confirm-actions">' +
          '<button type="button" class="btn btn-secondary" id="mglConfirmCancel">Cancel</button>' +
          '<button type="button" class="btn btn-primary" id="mglConfirmOk">Confirm</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    bindModal('mglConfirmModal', null);
  }

  /**
   * In-app confirm. options: { title, message, confirmLabel, cancelLabel, danger }
   * Resolves true/false.
   */
  function confirmAction(options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      ensureConfirmModal();
      var titleEl = document.getElementById('mglConfirmTitle');
      var msgEl = document.getElementById('mglConfirmMessage');
      var okBtn = document.getElementById('mglConfirmOk');
      var cancelBtn = document.getElementById('mglConfirmCancel');
      if (titleEl) titleEl.textContent = opts.title || 'Confirm';
      if (msgEl) msgEl.textContent = opts.message || 'Are you sure?';
      if (okBtn) {
        okBtn.textContent = opts.confirmLabel || 'Confirm';
        okBtn.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      }
      if (cancelBtn) cancelBtn.textContent = opts.cancelLabel || 'Cancel';

      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        closeModal('mglConfirmModal');
        resolve(!!value);
      }
      function onOk() { finish(true); }
      function onCancel() { finish(false); }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      openModal('mglConfirmModal', {
        titleId: 'mglConfirmTitle',
        focusSelector: '#mglConfirmCancel',
        onClose: function () { finish(false); }
      });
    });
  }

  function announce(message, politeness) {
    var el = document.getElementById('a11yAnnouncer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'a11yAnnouncer';
      el.className = 'sr-only';
      el.setAttribute('aria-live', politeness || 'polite');
      el.setAttribute('aria-atomic', 'true');
      document.body.appendChild(el);
    }
    el.textContent = '';
    setTimeout(function () { el.textContent = message || ''; }, 50);
  }

  function getFocusable(root) {
    if (!root) return [];
    return Array.prototype.slice.call(
      root.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(function (el) {
      return !el.hasAttribute('disabled') && el.offsetParent !== null;
    });
  }

  function onModalKeydown(e) {
    if (!modalState) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(modalState.id);
      return;
    }
    if (e.key !== 'Tab') return;
    var focusable = getFocusable(modalState.dialog);
    if (!focusable.length) {
      e.preventDefault();
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function openModal(id, options) {
    var opts = options || {};
    var overlay = document.getElementById(id);
    if (!overlay) return;
    var dialog = overlay.querySelector('.modal-content') || overlay;
    var titleId = opts.titleId || (dialog.querySelector('[id$="Title"], h2, h3') || {}).id;

    if (modalState && modalState.id !== id) closeModal(modalState.id);

    overlay.hidden = false;
    overlay.style.display = 'flex';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    if (titleId) overlay.setAttribute('aria-labelledby', titleId);

    dialog.setAttribute('role', 'document');

    modalState = {
      id: id,
      overlay: overlay,
      dialog: dialog,
      previousFocus: document.activeElement,
      onClose: typeof opts.onClose === 'function' ? opts.onClose : null
    };

    document.addEventListener('keydown', onModalKeydown);

    var focusable = getFocusable(dialog);
    var initial = opts.focusSelector
      ? dialog.querySelector(opts.focusSelector)
      : (focusable[0] || dialog);
    if (initial && initial.focus) {
      setTimeout(function () { initial.focus(); }, 0);
    }
  }

  function closeModal(id) {
    var targetId = id || (modalState && modalState.id);
    if (!targetId) return;
    var overlay = document.getElementById(targetId);
    if (overlay) {
      overlay.style.display = 'none';
      overlay.hidden = true;
      overlay.removeAttribute('aria-modal');
    }
    document.removeEventListener('keydown', onModalKeydown);
    var prev = modalState && modalState.previousFocus;
    var onClose = modalState && modalState.id === targetId ? modalState.onClose : null;
    if (modalState && modalState.id === targetId) modalState = null;
    if (typeof onClose === 'function') {
      try { onClose(); } catch (_) {}
    }
    if (prev && prev.focus) {
      try { prev.focus(); } catch (_) {}
    }
  }

  function bindModal(id, closeBtnId) {
    var overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.hidden = overlay.style.display === 'none' || !overlay.style.display;
    if (closeBtnId) {
      var btn = document.getElementById(closeBtnId);
      if (btn) {
        btn.setAttribute('type', btn.tagName === 'BUTTON' ? 'button' : undefined);
        btn.setAttribute('aria-label', 'Close dialog');
        btn.addEventListener('click', function () { closeModal(id); });
      }
    }
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal(id);
    });
  }

  /** Make .game-card elements keyboard-activatable (Enter/Space). */
  function bindActivatableCards(root, selector, onActivate) {
    var el = root || document;
    el.addEventListener('click', function (e) {
      var card = e.target.closest(selector);
      if (!card || e.target.closest('button, a, input, select, textarea, .btn')) return;
      onActivate(card, e);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest(selector);
      if (!card || e.target !== card) return;
      e.preventDefault();
      onActivate(card, e);
    });
  }

  function cardAttrs(label) {
    return 'role="button" tabindex="0" aria-label="' + esc(label || 'Open details') + '"';
  }

  function currentPageName() {
    var name = (location.pathname.split('/').pop() || 'dashboard.html').split('?')[0];
    if (!name || name === 'index.html') return 'dashboard.html';
    return name;
  }

  function safeNextUrl(fallback, nextOverride) {
    var next = (typeof nextOverride === 'string' && nextOverride)
      ? nextOverride
      : (new URLSearchParams(location.search).get('next') || '');
    if (!/^[a-zA-Z0-9._-]+\.html$/.test(next)) return fallback || 'dashboard.html';
    if (/^(auth|terms|privacy|404|index)\.html$/i.test(next)) return fallback || 'dashboard.html';
    return next;
  }

  function authUrlWithNext() {
    var page = currentPageName();
    if (!page || page === 'auth.html') return 'auth.html';
    return 'auth.html?next=' + encodeURIComponent(page);
  }

  function requireAuth() {
    if (getToken()) return true;
    location.href = authUrlWithNext();
    return false;
  }

  async function requireAuthAsync() {
    await ensureSession();
    if (getToken()) return true;
    location.href = authUrlWithNext();
    return false;
  }

  function redirectAfterLogin(fallback, nextOverride) {
    var page = safeNextUrl(fallback || 'dashboard.html', nextOverride);
    // Always stay on the current origin (never follow a stale localhost Site URL).
    try {
      location.assign(new URL(page, location.origin).href);
    } catch (_) {
      location.href = page;
    }
  }

  function logoutToAuth() {
    var finish = function () {
      clearSession();
      location.href = 'auth.html';
    };
    apiFetch('/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).then(finish).catch(finish);
  }

  /** Canonical page logout - clears cookie + storage. */
  function logout() {
    logoutToAuth();
  }

  var TOAST_ICON = {
    success: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
    error:   '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>',
    info:    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="0.25" fill="currentColor" stroke-width="1.5"/></svg>'
  };
  function toast(message, type) {
    var kind = type || 'info';
    var host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    el.className = 'toast toast-' + kind;
    el.innerHTML = '<span class="toast-icon">' + (TOAST_ICON[kind] || TOAST_ICON.info) + '</span>' +
      '<span class="toast-text"></span>';
    el.querySelector('.toast-text').textContent = String(message || '');
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('toast-out');
      setTimeout(function () { el.remove(); }, 250);
    }, 3200);
    if (typeof announce === 'function') announce(message);
  }

  function describeApiError(response, data, fallback) {
    var status = response && response.status;
    var msg = (data && (data.error || data.message)) || fallback || 'Something went wrong';
    if (status === 401) return 'Please sign in again.';
    if (status === 403) return msg || 'You do not have permission to do that.';
    if (status === 429) return 'Too many requests - wait a moment and try again.';
    if (status === 503) return 'Database unavailable. Try again shortly.';
    if (status >= 500) return 'Server error. If this continues, check /ready.';
    return msg;
  }

  // One consistent status vocabulary across every media type (no "watch" vs
  // "play" split), so the same status reads the same everywhere.
  var STATUS_KEYS = ['playing', 'completed', 'plan_to_play', 'on_hold', 'dropped'];
  var STATUS_LABEL_MAP = { playing: 'In progress', completed: 'Completed', plan_to_play: 'Planned', on_hold: 'On hold', dropped: 'Dropped' };

  function mediaTypeLabel(mediaType, plural) {
    var map = { game: 'Game', movie: 'Movie', series: 'Show', anime: 'Anime' };
    var base = map[mediaType] || 'Game';
    if (!plural) return base;
    if (mediaType === 'anime') return base; // uncountable
    return base + 's';
  }

  function statusLabel(status) {
    return STATUS_LABEL_MAP[status] || status || '';
  }

  function statusOptions(mediaType, selected) {
    return STATUS_KEYS.map(function (key) {
      var sel = key === selected ? ' selected' : '';
      return '<option value="' + key + '"' + sel + '>' + STATUS_LABEL_MAP[key] + '</option>';
    }).join('');
  }

  // Wire a score field: +/- steppers, a "clear" (No Score), and - importantly -
  // reject letters so only 1–10 or empty can be entered (type=number still lets
  // e/+/-/. through, hence the guards). Pass element ids (or the input node).
  function bindScoreInput(input, upId, downId, clearId) {
    input = (typeof input === 'string') ? document.getElementById(input) : input;
    if (!input) return;
    var up = upId && document.getElementById(upId);
    var down = downId && document.getElementById(downId);
    var clear = clearId && document.getElementById(clearId);
    function cur() { var n = parseInt(input.value, 10); return Number.isNaN(n) ? null : n; }
    function set(v) { input.value = (v == null) ? '' : String(Math.min(10, Math.max(1, v))); }
    if (up) up.onclick = function () { var n = cur(); set(n == null ? 1 : n + 1); };
    if (down) down.onclick = function () { var n = cur(); set(n == null ? 1 : n - 1); };
    if (clear) clear.onclick = function () { input.value = ''; };
    if (input.dataset.scoreBound) return; // don't stack listeners on a reused input
    input.dataset.scoreBound = '1';
    input.addEventListener('keydown', function (e) {
      if (['e', 'E', '+', '-', '.', ','].indexOf(e.key) !== -1) e.preventDefault();
    });
    input.addEventListener('input', function () {
      var v = String(input.value).replace(/[^0-9]/g, '');
      input.value = v ? String(Math.min(10, Math.max(1, parseInt(v, 10)))) : '';
    });
  }

  // ── Score meter (0–10, a draggable bar like a volume slider) ────────────
  // One thumb you drag or tap-to-jump, rather than eleven small tap targets -
  // the old dot row read as a cramped cluster on a phone. Keeps the same
  // hidden <input> so existing submit code reads `.value` unchanged; empty
  // value = "No score", 0 = a real "Trash" rating at the far left. Used by
  // the title page, quick-add and the library update dialogs so scoring
  // feels the same app-wide.
  var SCORE_WORDS = ['Trash', 'Awful', 'Bad', 'Rough', 'Meh', 'Mid', 'Decent', 'Solid', 'Fire', 'Elite', 'Peak'];

  function scoreMeterHTML(id, value) {
    var v = (value === 0 || (value != null && value !== '')) ? Number(value) : null;
    if (v != null) v = Math.min(10, Math.max(0, Math.round(v)));
    var pct = (v == null ? 0 : v * 10);
    // Positioned at the exact percentage each value sits at (i*10%), not laid
    // out with flex space-between - that spaced 9 ticks across 8 gaps, which
    // put them at 0/12.5/25...100% instead of on the 10 points the thumb
    // actually stops at.
    var ticks = '';
    for (var i = 1; i < 10; i++) ticks += '<span class="score-slider-tick" style="left:' + (i * 10) + '%"></span>';
    return '<div class="score-meter' + (v == null ? ' is-empty' : '') + '" data-score-meter="' + id + '">' +
        '<div class="score-meter-head">' +
          '<span class="score-meter-value">' + (v == null ? '–' : v) + '</span>' +
          '<span class="score-meter-word">' + (v == null ? 'No score' : SCORE_WORDS[v]) + '</span>' +
          '<button type="button" class="score-meter-clear"' + (v == null ? ' hidden' : '') + '>Clear</button>' +
        '</div>' +
        '<div class="score-slider" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="10"' +
          (v == null ? '' : ' aria-valuenow="' + v + '"') + ' aria-label="Score, 0 to 10">' +
          '<div class="score-slider-track">' +
            '<span class="score-slider-fill" style="width:' + pct + '%"></span>' +
            '<span class="score-slider-ticks" aria-hidden="true">' + ticks + '</span>' +
            '<span class="score-slider-thumb" style="left:' + pct + '%"></span>' +
          '</div>' +
        '</div>' +
        '<div class="score-meter-scale"><span>0 · Trash</span><span>10 · Peak</span></div>' +
        '<input type="hidden" id="' + id + '"' + (v == null ? '' : ' value="' + v + '"') + '>' +
      '</div>';
  }

  function bindScoreMeter(id) {
    var input = document.getElementById(id);
    if (!input) return;
    var meter = input.closest('.score-meter') || document.querySelector('[data-score-meter="' + id + '"]');
    if (!meter) return;
    var slider = meter.querySelector('.score-slider');
    var track  = meter.querySelector('.score-slider-track');

    function render(v) {
      v = (v === 0 || (v != null && v !== '')) ? Number(v) : null;
      input.value = (v == null) ? '' : String(v);
      meter.classList.toggle('is-empty', v == null);
      meter.querySelector('.score-meter-value').textContent = (v == null) ? '–' : v;
      meter.querySelector('.score-meter-word').textContent = (v == null) ? 'No score' : SCORE_WORDS[v];
      var clr = meter.querySelector('.score-meter-clear'); if (clr) clr.hidden = (v == null);
      var pct = (v == null ? 0 : v * 10);
      meter.querySelector('.score-slider-fill').style.width = pct + '%';
      meter.querySelector('.score-slider-thumb').style.left = pct + '%';
      if (v == null) slider.removeAttribute('aria-valuenow'); else slider.setAttribute('aria-valuenow', v);
    }
    meter._renderScore = render;
    if (meter.dataset.bound) return; // fresh markup each open, but guard reuse
    meter.dataset.bound = '1';

    function valueFromClientX(clientX) {
      var rect = track.getBoundingClientRect();
      var pct = rect.width ? (clientX - rect.left) / rect.width : 0;
      return Math.round(Math.min(1, Math.max(0, pct)) * 10);
    }

    var dragging = false;
    slider.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      dragging = true;
      slider.classList.add('dragging');
      slider.focus();
      try { slider.setPointerCapture(e.pointerId); } catch (_) {}
      render(valueFromClientX(e.clientX));
      e.preventDefault();
    });
    slider.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      render(valueFromClientX(e.clientX));
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      slider.classList.remove('dragging');
      try { slider.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);

    var clr = meter.querySelector('.score-meter-clear');
    if (clr) clr.addEventListener('click', function () { render(null); });

    slider.addEventListener('keydown', function (e) {
      var cur = input.value === '' ? null : Number(input.value);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); render(cur == null ? 0 : Math.max(0, cur - 1)); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); render(cur == null ? 0 : Math.min(10, cur + 1)); }
      else if (e.key === 'Home') { e.preventDefault(); render(0); }
      else if (e.key === 'End') { e.preventDefault(); render(10); }
    });
  }

  function mountAppNav() {
    var el = document.getElementById('appNav');
    if (!el) return;

    var active = el.getAttribute('data-active') || '';
    var brand = el.getAttribute('data-brand') || 'MediaListory';
    var user = getStoredUser();

    var isGuest = !getToken();
    var SEARCH_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';

    // Category tabs (one connected group; only the active one is filled).
    function tab(href, key, label, cat) {
      return '<a href="' + href + '" class="nav-tab' + (active === key ? ' active' : '') +
        '" data-cat="' + cat + '"' + (active === key ? ' aria-current="page"' : '') + '>' + label + '</a>';
    }
    // Neutral user-area links (My Library / Following).
    function ulink(href, key, label) {
      return '<a href="' + href + '" class="nav-link' + (active === key ? ' active' : '') + '"' +
        (active === key ? ' aria-current="page"' : '') + '>' + label + '</a>';
    }

    var primary =
      tab('movies.html', 'movies', 'Movies', 'movies') +
      tab('series.html', 'series', 'Shows', 'series') +
      tab('anime.html',  'anime',  'Anime',  'anime') +
      tab('home.html',   'games',  'Games',  'games');

    var PEOPLE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
    // People (Find & follow) lives as its own nav icon between Search and Theme.
    var peopleBtn = isGuest ? '' :
      '<a href="friends.html" class="nav-icon-btn' + (active === 'friends' ? ' active' : '') + '" id="navPeopleBtn" aria-label="Find and follow people" title="People">' + PEOPLE_SVG + '</a>';

    var utils =
      '<button type="button" class="nav-icon-btn" id="navSearchBtn" aria-label="Search all media" title="Search (press /)">' + SEARCH_SVG + '</button>' +
      peopleBtn +
      '<button type="button" class="nav-icon-btn" id="navThemeBtn" aria-label="Toggle light or dark theme"></button>';

    var userArea;
    if (isGuest) {
      userArea = '<a href="auth.html" class="nav-cta' + (active === 'auth' ? ' active' : '') + '">Sign in</a>';
    } else {
      var inMenu = (active === 'list' || active === 'profile' || active === 'moderator' || active === 'admin');
      var nameStr = (user && (user.display_name || user.username)) || 'You';
      var initials = nameStr.trim().slice(0, 2).toUpperCase() || 'U';
      var avaInner = (user && user.avatar_url)
        ? '<img src="' + esc(user.avatar_url) + '" alt="" onerror="this.remove()">'
        : esc(initials);

      var menuItems =
        '<div class="nav-menu-name" aria-hidden="true">' + esc(nameStr) + '</div>' +
        '<a role="menuitem" href="library.html" class="nav-menu-item' + (active === 'list' ? ' active' : '') + '">My Library</a>' +
        '<a role="menuitem" href="profile.html" class="nav-menu-item' + (active === 'profile' ? ' active' : '') + '">My profile</a>';
      menuItems += '<button type="button" role="menuitem" class="nav-menu-item nav-menu-danger" id="navLogoutBtn">Log out</button>';

      userArea =
        '<div class="nav-menu">' +
          '<button type="button" class="nav-menu-trigger nav-menu-trigger-ava' + (inMenu ? ' active' : '') + '" id="navProfileBtn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">' +
            '<span class="nav-ava" aria-hidden="true">' + avaInner + '</span>' +
            '<svg class="nav-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
          '</button>' +
          '<div class="nav-menu-pop" id="navProfileMenu" role="menu">' + menuItems + '</div>' +
        '</div>';
    }

    el.innerHTML =
      '<a class="nav-brand" href="dashboard.html">' + esc(brand) + '</a>' +
      '<nav class="nav-primary" aria-label="Categories">' + primary + '</nav>' +
      '<div class="nav-right">' + utils + userArea + '</div>' +
      '<button type="button" class="nav-toggle" id="navToggle" aria-expanded="false" aria-controls="appNav" aria-label="Open menu">' +
        '<span class="nav-toggle-bar" aria-hidden="true"></span>' +
        '<span class="nav-toggle-bar" aria-hidden="true"></span>' +
        '<span class="nav-toggle-bar" aria-hidden="true"></span>' +
      '</button>';

    var logoutBtn = document.getElementById('navLogoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logoutToAuth);

    var searchBtn = document.getElementById('navSearchBtn');
    if (searchBtn) {
      searchBtn.addEventListener('click', function () {
        if (typeof global.__openGlobalSearch === 'function') global.__openGlobalSearch();
      });
    }

    var themeBtn = document.getElementById('navThemeBtn');
    if (themeBtn) {
      paintThemeBtn(themeBtn, currentTheme());
      themeBtn.addEventListener('click', function () {
        applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
      });
    }

    // Profile dropdown (desktop). On mobile the menu shows inline in the drawer.
    var profileBtn = document.getElementById('navProfileBtn');
    var profileMenu = document.getElementById('navProfileMenu');
    if (profileBtn && profileMenu) {
      var menuWrap = profileBtn.parentNode;
      var closeMenu = function () { menuWrap.classList.remove('open'); profileBtn.setAttribute('aria-expanded', 'false'); };
      profileBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = menuWrap.classList.toggle('open');
        profileBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', function (e) { if (!menuWrap.contains(e.target)) closeMenu(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
    }

    // Mobile drawer toggle (hamburger opens category tabs + user links).
    var toggle = document.getElementById('navToggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var open = el.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        document.body.classList.toggle('nav-drawer-open', open);
      });
      el.querySelectorAll('.nav-tab, .nav-link, .nav-menu-item, .nav-cta').forEach(function (node) {
        node.addEventListener('click', function () {
          el.classList.remove('is-open');
          toggle.setAttribute('aria-expanded', 'false');
          toggle.setAttribute('aria-label', 'Open menu');
          document.body.classList.remove('nav-drawer-open');
        });
      });
    }
  }

  // ── Shared page header (title + subtitle; color comes from page theming) ─
  // Driven by the nav element's data-page-title / data-page-sub / data-active.
  function mountPageHeader() {
    var el = document.getElementById('appNav');
    if (!el) return;
    var title = el.getAttribute('data-page-title');
    if (!title) return;
    var sub = el.getAttribute('data-page-sub') || '';
    var active = el.getAttribute('data-active') || '';
    if (document.body) document.body.setAttribute('data-page', active);
    // Avoid a duplicate H1: the visible header becomes the page's single H1.
    var main = document.getElementById('main-content') || document.body;
    var srH1 = main.querySelector('h1.sr-only');
    if (srH1) srH1.parentNode.removeChild(srH1);
    var header = document.createElement('header');
    header.className = 'page-header';
    header.setAttribute('data-cat', active);
    header.innerHTML =
      '<div class="page-header-main">' +
        '<h1 class="page-header-title">' + esc(title) + '</h1>' +
        (sub ? '<p class="page-header-sub">' + esc(sub) + '</p>' : '') +
      '</div>';
    el.parentNode.insertBefore(header, el.nextSibling);
  }

  // ── Global search: a keyboard-driven overlay that searches all four media
  // types at once and deep-links into the matching title's detail. ──────────
  function mountGlobalSearch() {
    if (document.getElementById('globalSearch')) return;
    var PAGE_FOR = { movie: 'movies.html', series: 'series.html', anime: 'anime.html', game: 'home.html' };
    var GROUPS = [
      { cat: 'movie',  label: 'Movies', ep: '/tmdb/movies' },
      { cat: 'series', label: 'Shows',  ep: '/tmdb/series' },
      { cat: 'anime',  label: 'Anime',  ep: '/kitsu/anime' },
      { cat: 'game',   label: 'Games',  ep: '/igdb/games' }
    ];
    var overlay = document.createElement('div');
    overlay.id = 'globalSearch';
    overlay.className = 'gsearch';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="gsearch-box" role="dialog" aria-label="Search">' +
        '<div class="gsearch-bar">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
          '<input id="gsearchInput" type="text" placeholder="Search movies, shows, anime, games…" autocomplete="off" aria-label="Search all media" aria-controls="gsearchResults">' +
          '<button type="button" class="gsearch-esc" id="gsearchClose" aria-label="Close search">Esc</button>' +
        '</div>' +
        '<div id="gsearchResults" class="gsearch-results" role="listbox"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    var input = overlay.querySelector('#gsearchInput');
    var resultsEl = overlay.querySelector('#gsearchResults');
    var timer = null, activeIndex = -1, seq = 0;

    function open() { overlay.hidden = false; document.body.classList.add('gsearch-open'); setTimeout(function () { input.focus(); }, 30); }
    function close() { overlay.hidden = true; document.body.classList.remove('gsearch-open'); input.value = ''; resultsEl.innerHTML = ''; activeIndex = -1; }

    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#gsearchClose').addEventListener('click', close);

    function normalize(cat, arr) {
      if (!Array.isArray(arr)) return [];
      if (cat === 'game') {
        return arr.map(function (g) {
          var cover = (g.cover && g.cover.url) ? ('https:' + String(g.cover.url).replace('t_thumb', 't_cover_big')) : (g.background_image || null);
          return { id: 'igdb_' + g.id, media_type: 'game', name: g.name, background_image: cover, released: g.first_release_date ? new Date(g.first_release_date * 1000).toISOString() : null };
        }).filter(function (x) { return x.name; });
      }
      return arr.map(function (m) { return { id: m.id, media_type: m.media_type || cat, name: m.name, background_image: m.background_image, released: m.released }; })
                .filter(function (x) { return x.name; });
    }

    async function doSearch(q) {
      if (q.length < 2) { resultsEl.innerHTML = '<div class="gsearch-hint">Type at least 2 characters to search.</div>'; return; }
      var mine = ++seq;
      resultsEl.innerHTML = '<div class="gsearch-hint">Searching…</div>';
      var res = await Promise.all(GROUPS.map(function (g) {
        return apiFetch(g.ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ search: q, limit: 6 }) })
          .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
      }));
      if (mine !== seq) return; // a newer query superseded this one
      var html = '', idx = 0;
      GROUPS.forEach(function (g, i) {
        var items = normalize(g.cat, res[i]).slice(0, 6);
        if (!items.length) return;
        var single = g.label === 'Movies' ? 'Movie' : g.label === 'Shows' ? 'Show' : g.label === 'Games' ? 'Game' : 'Anime';
        html += '<div class="gsearch-group"><div class="gsearch-group-h">' + esc(g.label) + '</div>';
        items.forEach(function (it) {
          var year = it.released ? (' · ' + new Date(it.released).getFullYear()) : '';
          html += '<a class="gsearch-item" data-idx="' + (idx++) + '" role="option" href="title.html?ref=' + encodeURIComponent(it.id) + '">' +
            '<img src="' + esc(it.background_image || '/img/no-image.svg') + '" alt="" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
            '<span class="gsearch-item-txt"><span class="gsearch-item-name">' + esc(it.name) + '</span>' +
            '<span class="gsearch-item-meta">' + single + esc(year) + '</span></span>' +
          '</a>';
        });
        html += '</div>';
      });
      resultsEl.innerHTML = html || '<div class="gsearch-hint">No matches for “' + esc(q) + '”.</div>';
      activeIndex = -1;
    }

    function highlight(items) {
      items.forEach(function (el, i) { el.classList.toggle('active', i === activeIndex); });
      if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      timer = setTimeout(function () { doSearch(q); }, 300);
    });
    input.addEventListener('keydown', function (e) {
      var items = resultsEl.querySelectorAll('.gsearch-item');
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); highlight(items); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); highlight(items); }
      else if (e.key === 'Enter') { var t = items[activeIndex] || items[0]; if (t) window.location.href = t.getAttribute('href'); }
      else if (e.key === 'Escape') { close(); }
    });
    document.addEventListener('keydown', function (e) {
      if (!overlay.hidden) return;
      var typing = /^(input|textarea|select)$/i.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); open(); }
    });

    global.__openGlobalSearch = open;
  }

  // ── Shared footer ───────────────────────────────────────────────────────
  // One canonical footer for every app page (pages used to bake their own, and
  // they had drifted - some credited only IGDB, the dashboard had none at all).
  function mountAppFooter() {
    if (!document.getElementById('appNav')) return; // main app pages only
    // Drop any page-baked footer so exactly one, consistent footer shows.
    document.querySelectorAll('.site-footer').forEach(function (f) { f.remove(); });
    var host = document.getElementById('main-content') || document.body;
    var f = document.createElement('footer');
    f.className = 'site-footer';
    f.innerHTML =
      '<div class="footer-inner">' +
        '<div class="footer-brand">' +
          '<div class="brand-name">MediaListory</div>' +
          '<p>Track the movies, shows, anime, and games you love, discover what to enjoy next, and share your library with friends.</p>' +
        '</div>' +
        '<div class="footer-col"><h4>Browse</h4><ul>' +
          '<li><a href="movies.html">Movies</a></li>' +
          '<li><a href="series.html">Shows</a></li>' +
          '<li><a href="anime.html">Anime</a></li>' +
          '<li><a href="home.html">Games</a></li>' +
        '</ul></div>' +
        '<div class="footer-col"><h4>Your space</h4><ul>' +
          '<li><a href="library.html">My Library</a></li>' +
          '<li><a href="profile.html">Profile</a></li>' +
        '</ul></div>' +
        '<div class="footer-col"><h4>Data &amp; Credits</h4><ul>' +
          '<li><a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer">TMDB</a></li>' +
          '<li><a href="https://kitsu.io" target="_blank" rel="noopener noreferrer">Kitsu</a></li>' +
          '<li><a href="https://www.igdb.com" target="_blank" rel="noopener noreferrer">IGDB</a></li>' +
        '</ul></div>' +
      '</div>' +
      '<div class="footer-igdb"><div class="footer-igdb-text">' +
        'Movie &amp; show data from <a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer">TMDB</a> ' +
        '(this product uses the TMDB API but is not endorsed or certified by TMDB); anime from ' +
        '<a href="https://kitsu.io" target="_blank" rel="noopener noreferrer">Kitsu</a>; games from ' +
        '<a href="https://www.igdb.com" target="_blank" rel="noopener noreferrer">IGDB</a>, a Twitch service. ' +
        'All titles, images, and metadata are the property of their respective owners.' +
      '</div></div>' +
      '<div class="footer-bottom">' +
        '<span>© 2026 MediaListory. All rights reserved.</span>' +
        '<div class="footer-bottom-links">' +
          '<a href="about.html">About</a>' +
          '<a href="privacy.html">Privacy Policy</a>' +
          '<a href="terms.html">Terms of Service</a>' +
          '<a href="https://github.com/Gr33nOps" target="_blank" rel="noopener noreferrer">GitHub</a>' +
          '<a href="https://ko-fi.com/zain021xd" target="_blank" rel="noopener noreferrer">Support</a>' +
        '</div>' +
      '</div>';
    host.appendChild(f);
  }

  // Turn a horizontal overflow row into a clean scroller: hide the scrollbar,
  // wrap it with edge fades + prev/next arrows. Idempotent; call after render.
  function enhanceScrollers(root) {
    var scope = root || document;
    scope.querySelectorAll('.dash-scroller, .detail-cast, .detail-similar, .detail-shots, .detail-series, .person-gallery, .people-strip').forEach(function (sc) {
      if (sc.parentNode && sc.parentNode.classList.contains('scroller')) return;
      var wrap = document.createElement('div');
      wrap.className = 'scroller';
      sc.parentNode.insertBefore(wrap, sc);
      wrap.appendChild(sc);
      var mk = function (dir) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'scroller-arrow scroller-arrow-' + dir;
        b.setAttribute('aria-label', dir === 'left' ? 'Scroll left' : 'Scroll right');
        b.innerHTML = dir === 'left' ? '‹' : '›';
        b.addEventListener('click', function () {
          sc.scrollBy({ left: (dir === 'left' ? -1 : 1) * sc.clientWidth * 0.8, behavior: 'smooth' });
        });
        return b;
      };
      wrap.appendChild(mk('left'));
      wrap.appendChild(mk('right'));
      var update = function () {
        var max = sc.scrollWidth - sc.clientWidth;
        wrap.classList.toggle('no-scroll', max <= 4);
        wrap.classList.toggle('at-start', sc.scrollLeft <= 2);
        wrap.classList.toggle('at-end', sc.scrollLeft >= max - 2);
      };
      sc.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      // Images load late and change scrollWidth; recheck shortly after.
      setTimeout(update, 60); setTimeout(update, 600);
      update();
    });
  }
  global.enhanceScrollers = enhanceScrollers;

  /* ── Secondary sources on a detail view ───────────────────────────────────
     Price, MyAnimeList score, opening/ending themes and episode dates come
     from smaller APIs that sit outside the IGDB/TMDB/Kitsu core. They are
     fetched only after the detail view has already rendered, so a slow or
     missing source costs nothing: the block simply never appears.

     One helper serves both detail views (games in home.js, everything else in
     media-browse.js) so the two stay in step. */

  function enrichNum(n) {
    return typeof n === 'number' && isFinite(n) ? n.toLocaleString() : '';
  }

  // "Fri 18 Sep" for something upcoming, "18 Sep 2025" once it has aired.
  function enrichDate(iso, upcoming) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, upcoming
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // "S02E10" - or nothing at all for specials and TV movies, which carry a
  // season but no episode number.
  function enrichEpisodeCode(ep) {
    if (!ep || ep.season == null || ep.number == null) return '';
    var pad = function (v) { return (v < 10 ? '0' : '') + v; };
    return 'S' + pad(ep.season) + 'E' + pad(ep.number);
  }

  function enrichEpisodeLine(label, ep, upcoming) {
    if (!ep) return '';
    var code = enrichEpisodeCode(ep);
    var when = enrichDate(ep.airdate, upcoming);
    var title = ep.name ? '“' + esc(ep.name) + '”' : '';
    var bits = [code, title].filter(Boolean).join(' ');
    if (!bits && !when) return '';
    return '<p class="detail-ep">' +
      '<span class="detail-ep-label">' + esc(label) + '</span>' +
      '<span class="detail-ep-body">' + bits +
        (when ? '<span class="detail-ep-when">' + esc(when) + '</span>' : '') +
      '</span></p>';
  }

  function enrichSource(text, href) {
    var inner = href
      ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(text) + ' ↗</a>'
      : esc(text);
    return '<p class="detail-src">' + inner + '</p>';
  }

  function enrichDealHtml(deal) {
    if (!deal || !deal.price) return '';
    // Currency is stated outright: CheapShark quotes US dollars regardless of
    // where the visitor is, and an unlabelled "$9.99" would imply otherwise.
    var price = '$' + esc(deal.price) + ' USD' + (deal.store ? ' at ' + esc(deal.store) : '');
    var head = deal.url
      ? '<a class="detail-deal-price" href="' + esc(deal.url) + '" target="_blank" rel="noopener noreferrer">' + price + ' ↗</a>'
      : '<span class="detail-deal-price">' + price + '</span>';
    var was = (deal.retail && deal.percentOff > 0)
      ? '<span class="detail-deal-was">was $' + esc(deal.retail) + ' · ' + esc(String(deal.percentOff)) + '% off</span>'
      : '';
    return '<div class="detail-section">' +
      '<h3 class="detail-h">Best price today</h3>' +
      '<p class="detail-deal">' + head + was + '</p>' +
      enrichSource('Prices from CheapShark', 'https://www.cheapshark.com/') +
      '</div>';
  }

  function enrichMalHtml(mal) {
    if (!mal || mal.score == null) return '';
    var rows = '';
    var votes = enrichNum(mal.scoredBy);
    rows += '<div class="detail-prov-row"><span class="detail-prov-label">Score</span>' +
      '<span class="detail-prov-value"><strong>' + esc(mal.score.toFixed(2)) + '</strong><span class="dr-sub">/10</span>' +
      (votes ? ' <span class="detail-prov-note">from ' + esc(votes) + ' members</span>' : '') +
      '</span></div>';
    if (mal.rank) {
      rows += '<div class="detail-prov-row"><span class="detail-prov-label">Rank</span>' +
        '<span class="detail-prov-value">#' + esc(String(mal.rank)) + '</span></div>';
    }
    if (mal.studios && mal.studios.length) {
      rows += '<div class="detail-prov-row"><span class="detail-prov-label">Studio</span>' +
        '<span class="detail-prov-value">' + esc(mal.studios.join(', ')) + '</span></div>';
    }
    if (mal.broadcast) {
      rows += '<div class="detail-prov-row"><span class="detail-prov-label">Airs</span>' +
        '<span class="detail-prov-value">' + esc(mal.broadcast) + '</span></div>';
    }
    return '<div class="detail-section">' +
      '<h3 class="detail-h">On MyAnimeList</h3>' +
      '<div class="detail-providers">' + rows + '</div>' +
      enrichSource('View on MyAnimeList', mal.url) +
      '</div>';
  }

  function enrichThemesHtml(themes) {
    if (!themes || !themes.length) return '';
    // An ordered list, because openings and endings genuinely come in order.
    var items = themes.map(function (t) {
      return '<li class="detail-theme">' +
        '<span class="detail-theme-label">' + esc(t.label) + '</span>' +
        '<span class="detail-theme-title">' + esc(t.title) + '</span>' +
        (t.artists ? '<span class="detail-theme-artist">' + esc(t.artists) + '</span>' : '') +
        '</li>';
    }).join('');
    return '<div class="detail-section">' +
      '<h3 class="detail-h">Openings and endings</h3>' +
      '<ol class="detail-themes">' + items + '</ol>' +
      enrichSource('Themes from AnimeThemes', 'https://animethemes.moe/') +
      '</div>';
  }

  function enrichEpisodesHtml(eps) {
    if (!eps) return '';
    var body = enrichEpisodeLine('Next', eps.next, true) +
               enrichEpisodeLine('Last aired', eps.previous, false);
    if (!body) return '';
    // Only say a show has finished when TVmaze is sure of it.
    var note = (!eps.next && eps.status === 'Ended')
      ? '<p class="detail-ep-note">This show has finished airing.</p>' : '';
    return '<div class="detail-section">' +
      '<h3 class="detail-h">Episodes</h3>' + body + note +
      enrichSource('Episode dates from TVmaze', eps.url) +
      '</div>';
  }

  /**
   * Fetch the secondary sources for one title and append whatever came back.
   * Returns a cancel function - call it when the detail view closes so a slow
   * response cannot write into a modal the visitor has already left.
   */
  function mountEnrichment(container, kind, id) {
    var cancelled = false;
    if (!container || !kind || !id) return function () {};

    apiFetch('/enrich/' + kind + '/' + encodeURIComponent(id))
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        if (cancelled || !data || !container.isConnected) return;

        var html = kind === 'game'
          ? enrichDealHtml(data.deal)
          : kind === 'anime'
            ? enrichMalHtml(data.mal) + enrichThemesHtml(data.themes)
            : enrichEpisodesHtml(data.episodes);
        if (!html) return; // Nothing to say, so nothing is added.

        // Straight after the library panel: saving is what you came to do, so a
        // long list of themes must never push it down the page.
        var anchorEl = container.querySelector('.add-to-list');
        if (anchorEl && anchorEl.parentNode) {
          // nosemgrep: typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method -- html is built only from esc()-escaped values above
          anchorEl.insertAdjacentHTML('afterend', html);
        } else {
          // nosemgrep: typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method -- html is built only from esc()-escaped values above
          container.insertAdjacentHTML('beforeend', html);
        }
      })
      .catch(function () { /* Secondary data only - the page is already usable. */ });

    return function () { cancelled = true; };
  }

  global.mountEnrichment = mountEnrichment;

  // ── Loading skeletons ─────────────────────────────────────────────────────
  // Shared placeholders so every data view (browse, collection, profiles) shows
  // the same shimmer while it loads, not just the search grids.
  function skeletonCards(n) {
    var one = '<div class="skeleton-card"><div class="skeleton skel-poster"></div>' +
      '<div class="skel-info"><div class="skeleton skel-line w80"></div><div class="skeleton skel-line w50"></div></div></div>';
    return new Array(Math.max(1, n || 10)).fill(one).join('');
  }
  function skeletonRows(n) {
    var one = '<div class="skel-row"><div class="skeleton skel-row-img"></div>' +
      '<div class="skel-row-body"><div class="skeleton skel-line w50"></div><div class="skeleton skel-line w80"></div></div>' +
      '<div class="skeleton skel-row-badge"></div></div>';
    return new Array(Math.max(1, n || 6)).fill(one).join('');
  }
  function showSkeleton(target, kind, n) {
    var el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    el.innerHTML = (kind === 'rows') ? skeletonRows(n) : skeletonCards(n);
  }
  global.skeletonCards = skeletonCards;
  global.skeletonRows = skeletonRows;
  global.showSkeleton = showSkeleton;

  // ── Top navigation progress bar ───────────────────────────────────────────
  // Gives every page-to-page navigation immediate feedback, and completes when
  // the incoming page finishes loading.
  var progressBar = null, progressTimer = null;
  function ensureProgressBar() {
    if (progressBar) return progressBar;
    progressBar = document.createElement('div');
    progressBar.className = 'top-progress';
    document.body.appendChild(progressBar);
    return progressBar;
  }
  function startTopProgress() {
    var bar = ensureProgressBar();
    clearTimeout(progressTimer);
    bar.classList.remove('done');
    bar.style.transition = 'none';
    bar.style.width = '0%';
    bar.style.opacity = '1';
    // force reflow so the width reset applies before we animate
    void bar.offsetWidth;
    bar.style.transition = 'width 8s cubic-bezier(0.1, 0.7, 0.1, 1), opacity 0.3s';
    bar.style.width = '90%';
  }
  function finishTopProgress() {
    if (!progressBar) return;
    var bar = progressBar;
    bar.style.transition = 'width 0.25s ease, opacity 0.4s ease 0.2s';
    bar.style.width = '100%';
    bar.style.opacity = '0';
    progressTimer = setTimeout(function () { bar.style.width = '0%'; }, 600);
  }
  function mountTopProgress() {
    if (typeof document === 'undefined' || !document.body) return;
    ensureProgressBar();
    if (document.readyState === 'complete') { /* already loaded, no bar */ }
    else { startTopProgress(); window.addEventListener('load', finishTopProgress); }
    // Immediate feedback when leaving for another internal page.
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (a.target === '_blank' || a.hasAttribute('download') || href[0] === '#' ||
          /^(mailto:|tel:|javascript:)/i.test(href)) return;
      if (a.origin && a.origin !== location.origin) return;
      startTopProgress();
    }, true);
    window.addEventListener('pageshow', function (e) { if (e.persisted) finishTopProgress(); });
  }
  global.startTopProgress = startTopProgress;
  global.finishTopProgress = finishTopProgress;

  // ── "Waking the server" notice (Render cold start) ─────────────────────────
  // Only runs when the API is cross-origin (Vercel → Render). The page is already
  // interactive; this is a quiet, honest status line that appears only if the
  // backend doesn't answer within a short grace window, and clears itself the
  // moment it does. No full-screen blocker - the frontend never waits on it.
  function mountBackendWake() {
    if (typeof document === 'undefined' || !document.body) return;
    if (API_BASE.charAt(0) === '/') { markBackendReady(); return; } // same-origin: already up
    if (document.getElementById('backendWake')) return;

    // If the backend answered recently (this browser), treat it as still warm and
    // skip the panel entirely - otherwise every page navigation re-checks from
    // scratch and the cross-origin latency flashes "Server ready" each time.
    // A backend that answered recently is treated as still warm: no health poll
    // and no panel on arrival, so moving between pages never flashes a notice.
    // Requests are still watched below, so one that does hang explains itself.
    var recentlyReady = false;
    try {
      var readyAt = parseInt(localStorage.getItem('mgl:backendReadyAt') || '0', 10);
      recentlyReady = !!readyAt && (Date.now() - readyAt) < 10 * 60 * 1000;
    } catch (_) {}
    if (recentlyReady) markBackendReady();

    var GRACE_MS = 2500, MAX_MS = 75000, POLL_MS = 2500, SLOW_MS = 4000;
    var startedAt = Date.now();
    var el = null, hideTimer = null, elapsedTimer = null, stopped = false, slowTimer = null;

    var COPY = {
      waking: {
        t: 'Starting the server',
        m: 'The API goes to sleep when it isn’t being used. It’s waking up now. The first visit usually takes 30 to 60 seconds, then your page fills in on its own.'
      },
      ready: { t: 'Server ready', m: 'Loading your page…' },
      error: { t: 'Still can’t reach the server', m: 'This is taking longer than usual. Check your connection, then try again.' }
    };

    function build() {
      if (el) return el;
      el = document.createElement('div');
      el.id = 'backendWake';
      el.className = 'backend-wake';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.hidden = true;
      el.innerHTML =
        '<div class="backend-wake-panel">' +
          '<span class="backend-wake-ind" aria-hidden="true"></span>' +
          '<div class="backend-wake-body">' +
            '<strong class="backend-wake-title"></strong>' +
            '<span class="backend-wake-msg"></span>' +
            '<div class="backend-wake-bar" aria-hidden="true"><span></span></div>' +
            '<span class="backend-wake-meta">Waking up… <span class="backend-wake-elapsed">0s</span></span>' +
            '<button type="button" class="backend-wake-retry" hidden>Try again</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(el);
      el.querySelector('.backend-wake-retry').addEventListener('click', function () {
        startedAt = Date.now(); stopped = false; setState('waking'); poll();
      });
      return el;
    }
    function startElapsed() {
      if (elapsedTimer) return;
      var span = el.querySelector('.backend-wake-elapsed');
      var upd = function () { if (span) span.textContent = Math.max(0, Math.round((Date.now() - startedAt) / 1000)) + 's'; };
      upd();
      elapsedTimer = setInterval(upd, 1000);
    }
    function stopElapsed() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } }
    function setState(state) {
      build();
      var c = COPY[state] || COPY.waking;
      el.hidden = false;
      el.setAttribute('data-state', state);
      el.classList.remove('is-out');
      el.querySelector('.backend-wake-title').textContent = c.t;
      var msg = el.querySelector('.backend-wake-msg');
      msg.textContent = c.m; msg.hidden = !c.m;
      el.querySelector('.backend-wake-bar').hidden = (state !== 'waking');
      el.querySelector('.backend-wake-meta').hidden = (state !== 'waking');
      el.querySelector('.backend-wake-retry').hidden = (state !== 'error');
      if (state === 'waking') startElapsed(); else stopElapsed();
    }
    function hide() {
      stopElapsed();
      if (!el) return;
      el.classList.add('is-out');
      setTimeout(function () { if (el) { el.hidden = true; el.removeAttribute('data-state'); el.classList.remove('is-out'); } }, 350);
    }
    // Show the panel only when this page is genuinely waiting on the API and the
    // backend hasn't answered within the grace window - so static pages never see it.
    function maybeShow() {
      if (stopped || backendReady || el && !el.hidden && el.getAttribute('data-state') === 'waking') return;
      if (apiFetchStarted && (Date.now() - startedAt > GRACE_MS)) setState('waking');
    }
    function onReady() {
      stopped = true;
      stopElapsed();
      if (!el || el.hidden) return;
      if (el.getAttribute('data-state') !== 'ready') setState('ready');
      /* Always re-arm the hide. This used to clear a pending hide up front and
         then skip rescheduling it whenever the panel was already in the ready
         state, so the second onReady (poll() calls it again once the backend has
         answered) cancelled the dismissal and left "Server ready" on screen for
         good, over a page that had finished loading. */
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 900);
    }
    function poll() {
      if (stopped || backendReady) { onReady(); return; }
      pingHealth(6000).then(function (ok) {
        if (backendReady || ok) { onReady(); return; }
        if (stopped) return;
        if (Date.now() - startedAt > MAX_MS) { setState('error'); return; }
        maybeShow();
        setTimeout(poll, POLL_MS);
      });
    }

    // A request only earns a notice once it has actually been slow, so anything
    // that answers promptly never draws the panel and the UI stays quiet.
    function onApiStart() {
      if (slowTimer) return;
      slowTimer = setTimeout(function () {
        slowTimer = null;
        if (pendingApiCalls > 0 && (!el || el.hidden)) { startedAt = Date.now(); setState('waking'); }
      }, SLOW_MS);
    }
    // Everything settled: drop the watchdog and close the panel if it had opened.
    function onApiIdle() {
      if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
      if (el && !el.hidden && el.getAttribute('data-state') === 'waking') {
        setState('ready');
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 700);
      }
    }

    _onApiActivity = onApiStart;
    _onApiIdle = onApiIdle;
    document.addEventListener('mgl:backend-ready', onReady);
    // Page scripts run while the document is still parsing, so a page like the
    // dashboard has already fired its data calls by the time this mounts on
    // DOMContentLoaded. Those calls saw a null _onApiActivity and never armed the
    // watchdog, so a backend that was assumed warm but had gone cold left the
    // skeletons up with no notice at all. Arm it now for anything still waiting.
    if (pendingApiCalls > 0) onApiStart();
    // Only a genuinely cold start polls /health; a warm backend stays silent.
    if (!recentlyReady) { setTimeout(maybeShow, GRACE_MS); poll(); }
  }
  global.mountBackendWake = mountBackendWake;
  global.isBackendReady = isBackendReady;
  global.waitForBackend = waitForBackend;
  global.backendReadyPromise = backendReadyPromise;

  // ── Aurora atmosphere ──────────────────────────────────────────────────────
  // One reusable environmental light layer behind all content (dark theme only,
  // via CSS). Colours come from the page's category (CSS --au-* on body[data-page]);
  // intensity is stronger on marketing/auth, moderate on the dashboard, subtle in
  // the content-dense app - content always dominates. See ~/.claude/skills/aurora.
  function mountAurora() {
    if (typeof document === 'undefined' || !document.body) return;
    if (document.querySelector('.aurora')) return;
    var el = document.createElement('div');
    el.className = 'aurora';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<div class="aurora-blob aurora-blob-1"></div>' +
      '<div class="aurora-blob aurora-blob-2"></div>' +
      '<div class="aurora-blob aurora-blob-3"></div>';
    var path = (location.pathname || '').toLowerCase();
    var intensity = 'subtle';
    if (/(auth|about)\.html$/.test(path)) intensity = 'strong';      // marketing / entry
    else if (path === '/' || /dashboard\.html$/.test(path)) intensity = 'moderate'; // home hero
    el.setAttribute('data-i', intensity);
    document.body.insertBefore(el, document.body.firstChild);
  }
  global.mountAurora = mountAurora;

  // ── Reduced motion: hold animated avatars on their first frame ────────────
  // An animated GIF inside an <img> cannot be paused from CSS, and avatars show
  // up in followers lists and search results where a grid of looping pictures is
  // exactly the motion someone with the preference set has asked not to see.
  // Frame one is painted to a canvas and swapped in, so the picture still shows,
  // it just holds still. Only uploaded (same-origin data:) GIFs are touched;
  // a remote one would taint the canvas and is left alone.
  function freezeAnimatedAvatars() {
    if (typeof document === 'undefined' || !document.body || !global.matchMedia) return;
    if (!global.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    function freeze(img) {
      if (!img || img.getAttribute('data-still') === '1') return;
      var src = img.getAttribute('src') || '';
      // Uploaded avatars now come from their own cacheable URL rather than as a
      // data URI, so the animated ones are flagged with t=gif rather than being
      // recognisable from the source itself.
      var inline = src.slice(0, 15).toLowerCase() === 'data:image/gif;';
      var hosted = src.indexOf('/avatar?') !== -1 && src.indexOf('t=gif') !== -1;
      if (!inline && !hosted) return;
      img.setAttribute('data-still', '1');

      function paintFrom(source) {
        try {
          var c = document.createElement('canvas');
          c.width = source.naturalWidth || 128;
          c.height = source.naturalHeight || 128;
          c.getContext('2d').drawImage(source, 0, 0);
          img.src = c.toDataURL('image/png');
        } catch (_) { /* tainted or not decodable: leave it animating */ }
      }

      if (inline) {
        if (img.complete && img.naturalWidth) paintFrom(img);
        else img.addEventListener('load', function () { paintFrom(img); }, { once: true });
        return;
      }
      // A hosted avatar is cross-origin, so it has to be re-fetched with CORS
      // before a canvas will let us read it back. The route sends
      // Access-Control-Allow-Origin for exactly this.
      var probe = new Image();
      probe.crossOrigin = 'anonymous';
      probe.onload = function () { paintFrom(probe); };
      probe.src = src;
    }

    function scan(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.tagName === 'IMG') freeze(node);
      if (!node.querySelectorAll) return;
      var imgs = node.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) freeze(imgs[i]);
    }

    scan(document.body);
    // Avatars arrive with async renders, so catch the ones that land later too.
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) scan(added[j]);
        }
      }).observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }
  global.freezeAnimatedAvatars = freezeAnimatedAvatars;

  if (typeof document !== 'undefined') {
    initSentry(); // set up as early as possible so init-time errors are caught
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        initDensity();
        mountTopProgress();
        mountBackendWake();
        mountAppNav();
        mountAurora();
        mountPageHeader();
        mountGlobalSearch();
        mountAppFooter();
        freezeAnimatedAvatars();
        initAnalytics();
      });
    } else {
      initDensity();
      mountTopProgress();
      mountBackendWake();
      mountAppNav();
      mountAurora();
      mountPageHeader();
      mountGlobalSearch();
      mountAppFooter();
      freezeAnimatedAvatars();
      initAnalytics();
    }
  }

  global.esc = esc;
  global.API_BASE = API_BASE;
  global.getToken = getToken;
  global.ensureSession = ensureSession;
  global.getStoredUser = getStoredUser;
  global.calculateLevel = calculateLevel;
  global.authHeaders = authHeaders;
  global.apiFetch = apiFetch;
  global.clearSession = clearSession;
  global.announce = announce;
  global.openModal = openModal;
  global.closeModal = closeModal;
  global.bindModal = bindModal;
  global.bindActivatableCards = bindActivatableCards;
  global.cardAttrs = cardAttrs;
  global.safeNextUrl = safeNextUrl;
  global.authUrlWithNext = authUrlWithNext;
  global.requireAuth = requireAuth;
  global.requireAuthAsync = requireAuthAsync;
  global.redirectAfterLogin = redirectAfterLogin;
  global.logoutToAuth = logoutToAuth;
  global.logout = logout;
  global.mountAppNav = mountAppNav;
  global.toast = toast;
  global.describeApiError = describeApiError;
  global.notify = notify;
  global.confirmAction = confirmAction;
  global.getDensity = getDensity;
  global.applyDensity = applyDensity;
  global.initDensity = initDensity;
  global.mediaTypeLabel = mediaTypeLabel;
  global.statusLabel = statusLabel;
  global.statusOptions = statusOptions;
  // Shared button-loading state: spinner + text swap while an action is in
  // flight, restored exactly afterwards. One helper so every Save/Add/Delete
  // button in the app gets the same feedback instead of each screen inventing
  // its own "disable and rewrite textContent" pattern.
  function setBtnLoading(btn, loading, label) {
    if (!btn) return;
    if (loading) {
      if (btn.dataset.idleHtml == null) btn.dataset.idleHtml = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span><span>' + (label || 'Working…') + '</span>';
    } else {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      if (btn.dataset.idleHtml != null) { btn.innerHTML = btn.dataset.idleHtml; delete btn.dataset.idleHtml; }
    }
  }
  global.setBtnLoading = setBtnLoading;

  global.bindScoreInput = bindScoreInput;
  global.scoreMeterHTML = scoreMeterHTML;
  global.bindScoreMeter = bindScoreMeter;
  // n -> "Fire" (0 = Trash .. 10 = Peak), or '' for no score. Shared with every
  // badge that shows a saved score, so the same vocabulary reads everywhere.
  global.scoreWord = function (n) {
    if (n == null || n === '') return '';
    var i = Math.round(Number(n));
    return (i >= 0 && i <= 10) ? SCORE_WORDS[i] : '';
  };
  // The number + word badge shown on collection rows (coll-score-badge). One
  // place for the markup so every list renders a saved score the same way.
  global.scoreBadgeHTML = function (score) {
    if (score == null || score === '') return '<div class="coll-score-badge is-empty">–</div>';
    var word = global.scoreWord(score);
    return '<div class="coll-score-badge"><span class="csb-num">' + score + '</span>' +
      (word ? '<span class="csb-word">' + word + '</span>' : '') + '</div>';
  };
  global.MEDIA_STATUS_KEYS = STATUS_KEYS;
})(typeof window !== 'undefined' ? window : globalThis);



/* ── When a search overrules the sort and filters ────────────────────────────
   Searching does not mean the same thing at every provider. TMDB's search
   endpoint takes a query and nothing else, so a search throws away the sort and
   every filter. IGDB's search brings its own relevance order and refuses an
   explicit sort, but keeps filters. Kitsu keeps both, except that "popularity"
   during a search is really relevance.

   None of that is guessable from the browser, and hardcoding it here would
   drift the first time a provider changed, so the server says what it honoured
   and this reflects it. The controls stay put and stay readable - they are
   disabled, not hidden, because a control that vanishes reads as a bug - and a
   line underneath says why, with the one action that gives them back. */

function applyQueryStateNotice(state) {
    var notice = document.getElementById('queryStateNotice');
    if (!notice) {
        var host = document.querySelector('.search-container');
        if (!host) return;
        notice = document.createElement('p');
        notice.id = 'queryStateNotice';
        notice.className = 'query-state-notice';
        notice.hidden = true;
        host.appendChild(notice);
    }

    var sortEl = document.getElementById('sortBy');
    var filterBtn = document.getElementById('filterBtn');
    var sortState = (state && state.sortState) || 'applied';
    var filtersOff = state && state.filtersApplied === false;

    /* Disabled only when nothing the control offers would work. When it is just
       this choice that does not apply, the select stays usable - otherwise
       picking the sort that would have worked becomes impossible. */
    var sortDead = sortState === 'unavailable';
    if (sortEl) {
        sortEl.disabled = sortDead;
        sortEl.classList.toggle('is-locked', sortState !== 'applied');
        if (sortDead) sortEl.title = 'Search results come back in best-match order. Clear the search to sort.';
        else if (sortState === 'ignored') sortEl.title = 'Best match orders these results. Another sort will still apply.';
        else sortEl.removeAttribute('title');
    }
    if (filterBtn) {
        filterBtn.disabled = !!filtersOff;
        filterBtn.classList.toggle('is-locked', !!filtersOff);
        if (filtersOff) filterBtn.title = 'This search cannot be filtered. Clear it to use filters.';
        else filterBtn.removeAttribute('title');
    }

    /* The sentence that used to sit here said out loud what the controls
       already show: a greyed-out Sort next to a search box is self-explanatory,
       and the reason is still one hover away in the tooltip. Printing it beside
       every search was a banner nobody needed twice. */
    notice.hidden = true;
    notice.innerHTML = '';
}

/* Reads the two headers the list endpoints set. Absent headers mean the caller
   is talking to something that does not report state, so nothing is claimed. */
function queryStateFrom(response) {
    var sort = response.headers.get('X-Sort-State');
    var filters = response.headers.get('X-Filters-Applied');
    if (sort === null && filters === null) return null;
    return { sortState: sort || 'applied', filtersApplied: filters !== '0' };
}

/* ── What is already in the library ──────────────────────────────────────────
   Browse and search pages ask this to show that a title is already tracked, so
   nobody adds the same thing three times wondering whether it took. Loaded once
   per page from a small refs-only endpoint and kept up to date in memory as the
   user adds or edits, rather than re-fetched after every change. */
var __libraryIndex = null;

async function loadLibraryIndex(force) {
    if (__libraryIndex && !force) return __libraryIndex;
    if (typeof isGuest === 'function' && isGuest()) { __libraryIndex = {}; return __libraryIndex; }
    try {
        var r = await apiFetch('/user/games/refs');
        if (!r.ok) { __libraryIndex = {}; return __libraryIndex; }
        var rows = await r.json();
        var map = {};
        (Array.isArray(rows) ? rows : []).forEach(function (x) { if (x && x.ref) map[x.ref] = x; });
        __libraryIndex = map;
    } catch (e) {
        // No index just means no badges; browsing must still work.
        __libraryIndex = {};
    }
    return __libraryIndex;
}

function libraryEntry(ref) {
    return (__libraryIndex && ref) ? (__libraryIndex[ref] || null) : null;
}

function setLibraryEntry(ref, entry) {
    if (!__libraryIndex) __libraryIndex = {};
    if (entry) __libraryIndex[ref] = Object.assign({}, __libraryIndex[ref] || {}, entry, { ref: ref });
    else delete __libraryIndex[ref];
}

/* Ownership on a browse card is shown by the quick-add control turning into a
   tick, so the separate score chip in the corner was saying the same thing
   twice and cluttering the artwork. Kept as a no-op so existing callers and the
   refresh below stay valid. */
function ownedBadgeHtml(ref) {
    return '';
}

/* Update one card in place after an add or edit, so the badge appears without
   reloading the grid and losing the user's place. */
function refreshOwnedBadge(ref) {
    var cards = document.querySelectorAll('.game-card[data-game-id="' + (window.CSS && CSS.escape ? CSS.escape(ref) : ref) + '"]');
    for (var i = 0; i < cards.length; i++) {
        var wrap = cards[i].querySelector('.game-image-wrapper');
        if (!wrap) continue;
        var existing = wrap.querySelector('.card-owned');
        if (existing) existing.remove();
        var html = ownedBadgeHtml(ref);
        // nosemgrep: typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method -- built from esc()-escaped values in ownedBadgeHtml
        if (html) wrap.insertAdjacentHTML('beforeend', html);
    }
}

/* ── Forgiving text matching ─────────────────────────────────────────────────
   Used for searching your own collection, where an exact substring match is a
   bad deal: it fails on a typo, on words out of order, and on any punctuation
   the title happens to spell differently. "dark knight the", "darkknight" and
   "dark knght" should all find The Dark Knight. */

function normalizeText(value) {
    return String(value == null ? '' : value)
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/* Edit distance, but stop as soon as it exceeds `max` - the answer past that
   point is "not close", and computing how far is wasted work. */
function withinEditDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    var prev = [], curr = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
        curr[0] = i;
        var best = curr[0];
        for (j = 1; j <= b.length; j++) {
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
            if (curr[j] < best) best = curr[j];
        }
        if (best > max) return false;
        prev = curr.slice();
    }
    return prev[b.length] <= max;
}

function tokenMatches(token, word) {
    if (word.indexOf(token) === 0 || token.indexOf(word) === 0) return true;
    if (word.indexOf(token) !== -1) return true;
    // Only allow a typo once a word is long enough for one to be unambiguous.
    if (token.length < 4) return false;
    return withinEditDistance(word, token, token.length >= 7 ? 2 : 1);
}

/* True when `query` is a plausible way of asking for `text`. */
function fuzzyMatches(text, query) {
    var q = normalizeText(query);
    if (!q) return true;
    var t = normalizeText(text);
    if (!t) return false;
    if (t.indexOf(q) !== -1) return true;
    // Ignoring spaces catches "darkknight" and "star wars" written as one word.
    if (t.replace(/ /g, '').indexOf(q.replace(/ /g, '')) !== -1) return true;

    var words = t.split(' ');
    return q.split(' ').every(function (token) {
        return words.some(function (word) { return tokenMatches(token, word); });
    });
}
