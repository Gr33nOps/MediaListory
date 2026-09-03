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
  // Default same-origin `/api` (local + Vercel rewrite). Override with window.MGL_API_BASE
  // only if calling Render directly (e.g. https://xxx.onrender.com/api).
  var API_BASE = (typeof global.MGL_API_BASE === 'string' && global.MGL_API_BASE)
    ? global.MGL_API_BASE.replace(/\/$/, '')
    : '/api';
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
      if (user && user.id) S.setUser({ id: String(user.id) }); // id only — no email/PII
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
    // Cross-origin API (direct Render) needs include; same-origin rewrite keeps cookies simple.
    opts.credentials = opts.credentials || (apiIsCrossOrigin() ? 'include' : 'same-origin');
    opts.cache = opts.cache || 'no-store';
    return fetch(API_BASE + path, opts);
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
    var name = (location.pathname.split('/').pop() || 'home.html').split('?')[0];
    if (!name || name === 'index.html') return 'home.html';
    return name;
  }

  function safeNextUrl(fallback, nextOverride) {
    var next = (typeof nextOverride === 'string' && nextOverride)
      ? nextOverride
      : (new URLSearchParams(location.search).get('next') || '');
    if (!/^[a-zA-Z0-9._-]+\.html$/.test(next)) return fallback || 'home.html';
    if (/^(auth|terms|privacy|404|index)\.html$/i.test(next)) return fallback || 'home.html';
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
    var page = safeNextUrl(fallback || 'home.html', nextOverride);
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
    el.textContent = String(message || '');
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

  // Wire a score field: +/- steppers, a "clear" (No Score), and — importantly —
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
        '<a role="menuitem" href="myGameList.html" class="nav-menu-item' + (active === 'list' ? ' active' : '') + '">My Library</a>' +
        '<a role="menuitem" href="profile.html" class="nav-menu-item' + (active === 'profile' ? ' active' : '') + '">My profile</a>';
      if (user && (user.is_moderator || user.is_admin)) {
        menuItems += '<a role="menuitem" href="moderator.html" class="nav-menu-item' + (active === 'moderator' ? ' active' : '') + '">Moderate</a>';
      }
      if (user && user.is_admin) {
        menuItems += '<a role="menuitem" href="admin.html" class="nav-menu-item' + (active === 'admin' ? ' active' : '') + '">Admin</a>';
      }
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
          html += '<a class="gsearch-item" data-idx="' + (idx++) + '" role="option" href="' + PAGE_FOR[it.media_type] + '?open=' + encodeURIComponent(it.id) + '">' +
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
  // they had drifted — some credited only IGDB, the dashboard had none at all).
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
          '<li><a href="myGameList.html">My Library</a></li>' +
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
        '</div>' +
      '</div>';
    host.appendChild(f);
  }

  // Turn a horizontal overflow row into a clean scroller: hide the scrollbar,
  // wrap it with edge fades + prev/next arrows. Idempotent; call after render.
  function enhanceScrollers(root) {
    var scope = root || document;
    scope.querySelectorAll('.dash-scroller, .detail-cast, .detail-similar, .detail-shots').forEach(function (sc) {
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

  if (typeof document !== 'undefined') {
    initSentry(); // set up as early as possible so init-time errors are caught
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        initDensity();
        mountTopProgress();
        mountAppNav();
        mountPageHeader();
        mountGlobalSearch();
        mountAppFooter();
        initAnalytics();
      });
    } else {
      initDensity();
      mountTopProgress();
      mountAppNav();
      mountPageHeader();
      mountGlobalSearch();
      mountAppFooter();
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
  global.bindScoreInput = bindScoreInput;
  global.MEDIA_STATUS_KEYS = STATUS_KEYS;
})(typeof window !== 'undefined' ? window : globalThis);
