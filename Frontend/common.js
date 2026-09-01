/** Shared frontend helpers: escaping, auth token, API, a11y modals/cards */
(function (global) {
  // ── Site config ────────────────────────────────────────────────────
  // To enable Google Analytics 4, put your measurement ID here (e.g. 'G-ABC123').
  // Leave empty to disable analytics entirely. Honors Do Not Track.
  global.MGL_GA_ID = global.MGL_GA_ID || '';
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

  // Same internal status keys across all media; labels differ per category so the
  // UI reads naturally (games "play", movies/series "watch").
  var STATUS_KEYS = ['playing', 'completed', 'plan_to_play', 'on_hold', 'dropped'];
  var STATUS_LABELS = {
    game:   { playing: 'Playing', completed: 'Completed', plan_to_play: 'Plan to Play', on_hold: 'On Hold', dropped: 'Dropped' },
    movie:  { playing: 'Watching', completed: 'Watched', plan_to_play: 'Plan to Watch', on_hold: 'On Hold', dropped: 'Dropped' },
    series: { playing: 'Watching', completed: 'Completed', plan_to_play: 'Plan to Watch', on_hold: 'On Hold', dropped: 'Dropped' },
    anime:  { playing: 'Watching', completed: 'Completed', plan_to_play: 'Plan to Watch', on_hold: 'On Hold', dropped: 'Dropped' }
  };

  function mediaTypeLabel(mediaType, plural) {
    var map = { game: 'Game', movie: 'Movie', series: 'Show', anime: 'Anime' };
    var base = map[mediaType] || 'Game';
    if (!plural) return base;
    if (mediaType === 'anime') return base; // uncountable
    return base + 's';
  }

  function statusLabel(status, mediaType) {
    var set = STATUS_LABELS[mediaType] || STATUS_LABELS.game;
    return set[status] || status || '';
  }

  function statusOptions(mediaType, selected) {
    var set = STATUS_LABELS[mediaType] || STATUS_LABELS.game;
    return STATUS_KEYS.map(function (key) {
      var sel = key === selected ? ' selected' : '';
      return '<option value="' + key + '"' + sel + '>' + set[key] + '</option>';
    }).join('');
  }

  function mountAppNav() {
    var el = document.getElementById('appNav');
    if (!el) return;

    var active = el.getAttribute('data-active') || '';
    var brand = el.getAttribute('data-brand') || 'MediaListory';
    var user = getStoredUser();

    function link(href, key, label, cat) {
      var cls = 'btn btn-secondary' + (active === key ? ' active' : '');
      var attr = cat ? ' data-cat="' + cat + '"' : '';
      return '<a href="' + href + '" class="' + cls + '"' + attr +
        (active === key ? ' aria-current="page"' : '') + '>' + label + '</a>';
    }

    // Four media categories in one app: Movies + Series (TMDB), Anime (Kitsu), Games (IGDB).
    var isGuest = !getToken();

    var actions =
      link('movies.html', 'movies', 'Movies', 'movies') +
      link('series.html', 'series', 'Shows', 'series') +
      link('anime.html', 'anime', 'Anime', 'anime') +
      link('home.html', 'games', 'Games', 'games');

    if (isGuest) {
      // Guests can browse everything; account features prompt sign-in.
      actions += '<a href="auth.html" class="btn btn-primary' + (active === 'auth' ? ' active' : '') + '">Sign in</a>';
    } else {
      actions +=
        link('myGameList.html', 'list', 'My Library') +
        link('friends.html', 'friends', 'Following') +
        link('profile.html', 'profile', 'Profile');

      if (user && (user.is_moderator || user.is_admin)) {
        actions += link('moderator.html', 'moderator', 'Modify');
      }
      if (user && user.is_admin) {
        actions += link('admin.html', 'admin', 'Manage');
      }

      actions += '<button type="button" class="btn btn-danger" id="navLogoutBtn">Logout</button>';
    }

    el.innerHTML =
      '<div class="nav-bar-top">' +
        '<a class="nav-brand" href="home.html">' + esc(brand) + '</a>' +
        '<button type="button" class="nav-toggle" id="navToggle" aria-expanded="false" aria-controls="navActions" aria-label="Open menu">' +
          '<span class="nav-toggle-bar" aria-hidden="true"></span>' +
          '<span class="nav-toggle-bar" aria-hidden="true"></span>' +
          '<span class="nav-toggle-bar" aria-hidden="true"></span>' +
        '</button>' +
      '</div>' +
      '<div class="nav-actions" id="navActions">' + actions + '</div>';

    var logoutBtn = document.getElementById('navLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', logoutToAuth);
    }

    var toggle = document.getElementById('navToggle');
    var panel = document.getElementById('navActions');
    if (toggle && panel) {
      toggle.addEventListener('click', function () {
        var open = el.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        document.body.classList.toggle('nav-drawer-open', open);
      });
      panel.querySelectorAll('a, button').forEach(function (node) {
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

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        initDensity();
        mountAppNav();
        mountPageHeader();
        initAnalytics();
      });
    } else {
      initDensity();
      mountAppNav();
      mountPageHeader();
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
  global.MEDIA_STATUS_KEYS = STATUS_KEYS;
})(typeof window !== 'undefined' ? window : globalThis);
