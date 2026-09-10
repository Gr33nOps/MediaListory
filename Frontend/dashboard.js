/* Home dashboard: greeting/pitch, "Up Next" (in-progress shows & anime with a
   one-tap +1), and a Trending row per category. Cards link straight to
   the title's own page (title.html?ref=<ref>). */
(function () {
  var API = (typeof API_BASE === 'string' && API_BASE) ? API_BASE : '/api';
  // Every data call goes through apiFetch so it is counted by the cold-start
  // watchdog in common.js. A raw fetch here is invisible to it, which leaves the
  // trending skeletons sitting there with no "Starting the server" notice while
  // Render boots. Falls back to plain fetch only if common.js somehow missed.
  var api = (typeof apiFetch === 'function')
    ? apiFetch
    : function (path, opts) { return fetch(API + path, opts); };
  var token = (typeof getToken === 'function') ? getToken() : '';
  var isGuest = !token;
  var user = (typeof getStoredUser === 'function') ? getStoredUser() : null;

  var PAGE_FOR = { movie: 'movies.html', series: 'series.html', anime: 'anime.html', game: 'home.html' };
  var CAT_FOR = { movie: 'movies', series: 'series', anime: 'anime', game: 'games' };
  var LABEL = { movie: 'movies', series: 'shows', anime: 'anime', game: 'games' };

  function esc(s) {
    if (typeof window.esc === 'function') return window.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function posterCard(item) {
    var ref = item.id;
    var rating = item.rating ? '<span class="card-rating">★ ' + esc(Number(item.rating).toFixed(1)) + '</span>' : '';
    return '<a class="dash-card" href="title.html?ref=' + encodeURIComponent(ref) + '" title="' + esc(item.name) + '">' +
      '<div class="dash-card-poster">' +
        '<img src="' + esc(item.background_image || '/img/no-image.svg') + '" alt="' + esc(item.name) + '" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' + rating +
      '</div>' +
      '<span class="dash-card-name">' + esc(item.name) + '</span>' +
    '</a>';
  }

  function rowShell(title, inner, cat) {
    return '<section class="dash-row"' + (cat ? ' data-cat="' + cat + '"' : '') + '>' +
      '<h2 class="dash-row-title">' + esc(title) + '</h2>' +
      '<div class="dash-scroller">' + inner + '</div>' +
    '</section>';
  }

  function skelRow() {
    var one = '<div class="dash-card"><div class="dash-card-poster skeleton"></div></div>';
    return new Array(8).join(one) + one;
  }

  function renderHero() {
    var el = document.getElementById('dashHero');
    if (!el) return;
    if (isGuest) {
      el.innerHTML = '<div class="dash-hero-inner">' +
        '<h2 class="dash-hero-title">Everything you watch and play, in one place</h2>' +
        '<p class="dash-hero-sub">Track movies, shows, anime, and games. Rate them, follow your episode progress, and keep one library.</p>' +
        '<div class="dash-hero-cta">' +
          '<a class="btn btn-primary" href="auth.html">Create a free account</a>' +
          '<a class="btn btn-secondary" href="movies.html">Browse without an account</a>' +
        '</div>' +
      '</div>';
    } else {
      var name = (user && (user.display_name || user.username)) || 'back';
      el.innerHTML = '<div class="dash-hero-inner">' +
        '<h2 class="dash-hero-title">Welcome back, ' + esc(name) + '</h2>' +
        '<p class="dash-hero-sub">Pick up where you left off, or find something new below.</p>' +
      '</div>';
    }
  }

  // ── Up Next (logged-in) ─────────────────────────────────────────────────
  var libCache = [];

  function upNextItems() {
    return libCache.filter(function (g) {
      return (g.media_type === 'series' || g.media_type === 'anime') && g.episode_count &&
        g.status === 'playing' && (g.progress || 0) < g.episode_count;
    });
  }

  function renderUpNext() {
    var host = document.getElementById('dashUpNext');
    if (!host) return;
    var items = upNextItems();
    if (!items.length) { host.innerHTML = ''; return; }
    var cards = items.map(function (g) {
      var prog = g.progress || 0;
      var pct = Math.min(100, Math.round(prog / g.episode_count * 100));
      return '<div class="dash-upnext-card">' +
        '<a class="dash-upnext-poster" href="title.html?ref=' + encodeURIComponent(g.media_ref || g.game_id) + '" title="' + esc(g.name) + '">' +
          '<img src="' + esc(g.background_image || '/img/no-image.svg') + '" alt="' + esc(g.name) + '" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
        '</a>' +
        '<div class="dash-upnext-info">' +
          '<div class="dash-upnext-name">' + esc(g.name) + '</div>' +
          '<div class="dash-upnext-prog">' +
            '<span class="coll-progress-bar"><span class="coll-progress-fill" style="width:' + pct + '%"></span></span>' +
            '<span class="coll-progress-text">' + prog + ' / ' + g.episode_count + '</span>' +
          '</div>' +
          '<button type="button" class="btn btn-primary btn-sm dash-plus" data-id="' + esc(g.game_id) + '">+1 episode</button>' +
        '</div>' +
      '</div>';
    }).join('');
    host.innerHTML = '<section class="dash-row"><h2 class="dash-row-title">Up next</h2><div class="dash-upnext">' + cards + '</div></section>';
  }

  async function loadUpNext() {
    if (isGuest) return;
    try {
      var r = await api('/user/games');
      if (!r.ok) return;
      var d = await r.json();
      libCache = d.games || [];
      renderUpNext();
    } catch (_) {}
  }

  document.addEventListener('click', async function (e) {
    var btn = e.target.closest('.dash-plus');
    if (!btn) return;
    e.preventDefault();
    var id = btn.dataset.id;
    var g = libCache.find(function (x) { return String(x.game_id) === String(id); });
    if (!g) return;
    var next = (g.progress || 0) + 1;
    var status = g.status;
    if (next >= g.episode_count && status === 'playing') status = 'completed';
    btn.disabled = true;
    try {
      var r = await api('/user/games/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status, score: g.score || null, progress: next })
      });
      if (r.ok) {
        g.progress = next; g.status = status;
        renderUpNext();
        if (typeof toast === 'function') toast(next >= g.episode_count ? '“' + g.name + '” completed!' : 'Marked episode ' + next, 'success');
      } else {
        btn.disabled = false;
        if (typeof toast === 'function') toast('Could not update progress.', 'error');
      }
    } catch (_) { btn.disabled = false; }
  });

  // ── Trending & Top rated ──────────────────────────────────────────────────
  // Two rows per category, both built from the same row + poster components -
  // "Trending" is the popular/recent feed, "Top rated" is the highest scored.
  var TRENDING = [
    { cat: 'movie',  endpoint: '/tmdb/movies', body: { sort: 'popularity', limit: 14 } },
    { cat: 'series', endpoint: '/tmdb/series', body: { sort: 'popularity', limit: 14 } },
    { cat: 'anime',  endpoint: '/kitsu/anime', body: { trending: true, limit: 14 } },
    { cat: 'game',   endpoint: '/igdb/games',  body: { trending: true, limit: 14 } }
  ];
  var TOP_RATED = [
    { cat: 'movie',  endpoint: '/tmdb/movies', body: { sort: 'rating', limit: 14 } },
    { cat: 'series', endpoint: '/tmdb/series', body: { sort: 'rating', limit: 14 } },
    { cat: 'anime',  endpoint: '/kitsu/anime', body: { sort: 'rating', limit: 14 } },
    { cat: 'game',   endpoint: '/igdb/games',  body: { sort: 'rating', limit: 14 } }
  ];

  // TMDB/Kitsu proxies return normalized objects; IGDB returns raw shape.
  function normalizeList(cat, arr) {
    if (!Array.isArray(arr)) return [];
    if (cat === 'game') {
      return arr.map(function (g) {
        var cover = (g.cover && g.cover.url)
          ? ('https:' + String(g.cover.url).replace('t_thumb', 't_cover_big'))
          : (g.background_image || null);
        return {
          id: 'igdb_' + g.id, media_type: 'game', name: g.name, background_image: cover,
          rating: g.total_rating ? Number((g.total_rating / 20).toFixed(1)) : (g.rating || null)
        };
      }).filter(function (x) { return x.name && x.background_image; });
    }
    return arr.map(function (m) {
      return { id: m.id, media_type: m.media_type || cat, name: m.name, background_image: m.background_image, rating: m.rating };
    }).filter(function (x) { return x.name && x.background_image; });
  }

  async function loadRowGroup(configs, containerId, prefix, emptyMsg) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = configs.map(function (t) {
      return rowShell(prefix + ' ' + LABEL[t.cat], skelRow(), CAT_FOR[t.cat]);
    }).join('');
    var results = await Promise.all(configs.map(function (t) {
      return api(t.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t.body) })
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    }));
    var html = '';
    configs.forEach(function (t, i) {
      var items = normalizeList(t.cat, results[i]).slice(0, 14);
      if (!items.length) return;
      html += rowShell(prefix + ' ' + LABEL[t.cat], items.map(posterCard).join(''), CAT_FOR[t.cat]);
    });
    container.innerHTML = html || (emptyMsg ? '<p class="dash-empty">' + emptyMsg + '</p>' : '');
    if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(container);
  }

  renderHero();
  loadUpNext();
  loadRowGroup(TRENDING, 'dashTrending', 'Trending', 'Could not load trending right now. Try refreshing.');
  loadRowGroup(TOP_RATED, 'dashTopRated', 'Top rated', '');
})();
