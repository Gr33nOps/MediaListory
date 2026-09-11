/* Home dashboard: a personal control panel, not a trending page.

   Everything a signed-in user sees below the hero comes from ONE bulk fetch
   (/api/user/games) plus a handful of small, capped calls for the sections
   that need data this app doesn't already have client-side (similar taste,
   friends' activity, trending, upcoming). Movies, shows, anime and games are
   never merged into one mixed feed - each stays in its own column, because
   they are different kinds of thing and mixing them just makes both harder
   to scan.

   Section order: what the user is in the middle of, what they've rated
   lately, a small social read, then discovery (trending, then upcoming) -
   each category kept side by side rather than blended. */
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
  var LABEL_SINGULAR = { movie: 'Movie', series: 'Show', anime: 'Anime', game: 'Game' };
  var LABEL_PLURAL = { movie: 'Movies', series: 'Shows', anime: 'Anime', game: 'Games' };
  var CAT_ORDER = ['movie', 'series', 'anime', 'game'];

  function esc(s) {
    if (typeof window.esc === 'function') return window.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function catBadge(mediaType) {
    return '<span class="cl-cat-badge" data-cat="' + mediaType + '">' + esc(LABEL_SINGULAR[mediaType] || 'Game') + '</span>';
  }

  // Poster card shared by Recent ratings (the user's own score) and
  // Trending/Upcoming (the catalog rating) - same visual language either way.
  function posterCard(item) {
    var ref = item.id;
    var overlay = '';
    if (item.userScore != null) {
      var word = (typeof window.scoreWord === 'function') ? window.scoreWord(item.userScore) : '';
      overlay = '<span class="card-rating" title="Your score">' + esc(item.userScore) + (word ? ' · ' + esc(word) : '') + '</span>';
    } else if (item.rating) {
      overlay = '<span class="card-rating">★ ' + esc(Number(item.rating).toFixed(1)) + '</span>';
    }
    return '<a class="dash-card" href="title.html?ref=' + encodeURIComponent(ref) + '" title="' + esc(item.name) + '">' +
      '<div class="dash-card-poster">' +
        '<img src="' + esc(item.background_image || '/img/no-image.svg') + '" alt="' + esc(item.name) + '" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' + overlay +
      '</div>' +
      '<span class="dash-card-name">' + esc(item.name) + '</span>' +
    '</a>';
  }

  function rowShell(title, inner, cat, link) {
    var head = '<h2 class="dash-row-title">' + esc(title) + '</h2>' +
      (link ? '<a class="dash-row-link" href="' + link.href + '">' + esc(link.text) + '</a>' : '');
    return '<section class="dash-row"' + (cat ? ' data-cat="' + cat + '"' : '') + '>' +
      (link ? '<div class="dash-section-head">' + head + '</div>' : head) +
      '<div class="dash-scroller">' + inner + '</div>' +
    '</section>';
  }

  function skelRow() {
    var one = '<div class="dash-card"><div class="dash-card-poster skeleton"></div></div>';
    return new Array(8).join(one) + one;
  }

  // ── Hero ─────────────────────────────────────────────────────────────────
  function catCountsHtml(byCat) {
    return '<div class="dash-hero-counts">' + CAT_ORDER.map(function (cat) {
      return '<a class="cat-stat" data-cat="' + cat + '" href="library.html?media=' + cat + '" title="View your ' + esc(LABEL_PLURAL[cat]) + '">' +
        '<span class="cs-num">' + (byCat[cat] || 0) + '</span><span class="cs-label">' + LABEL_PLURAL[cat] + '</span></a>';
    }).join('') + '</div>';
  }

  function renderHero(weekCount, byCat) {
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
      return;
    }
    var name = (user && (user.display_name || user.username)) || 'back';
    var total = byCat ? (byCat.movie + byCat.series + byCat.anime + byCat.game) : 0;
    var sub;
    if (weekCount > 0) {
      sub = 'You’ve finished ' + weekCount + (weekCount === 1 ? ' title' : ' titles') + ' this week. Pick up where you left off, or find something new below.';
    } else if (!total) {
      sub = 'Your library is empty. Search for something you’ve watched or played to start tracking it.';
    } else {
      sub = 'Pick up where you left off, or find something new below.';
    }
    el.innerHTML = '<div class="dash-hero-inner">' +
      '<h2 class="dash-hero-title">Welcome back, ' + esc(name) + '</h2>' +
      '<p class="dash-hero-sub">' + esc(sub) + '</p>' +
      (total ? catCountsHtml(byCat) : '') +
    '</div>';
  }

  // ── Continue (in-progress, every category) ──────────────────────────────
  var libCache = [];

  function continueItems() {
    return libCache
      .filter(function (g) { return g.status === 'playing'; })
      .sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })
      .slice(0, 12);
  }

  function continueCardHtml(g) {
    var mt = g.media_type || 'game';
    var hasEpisodes = (mt === 'series' || mt === 'anime') && g.episode_count;
    var infoHtml;
    if (hasEpisodes) {
      var prog = g.progress || 0;
      var pct = Math.min(100, Math.round(prog / g.episode_count * 100));
      infoHtml = '<div class="dash-upnext-prog">' +
          '<span class="coll-progress-bar"><span class="coll-progress-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="coll-progress-text">' + prog + ' / ' + g.episode_count + ' eps</span>' +
        '</div>' +
        (prog < g.episode_count
          ? '<button type="button" class="btn btn-primary btn-sm dash-plus" data-id="' + esc(g.game_id) + '">+1 episode</button>'
          : '');
    } else {
      infoHtml = '<div class="dash-upnext-status">In progress</div>';
    }
    return '<div class="dash-upnext-card">' +
      '<a class="dash-upnext-poster" href="title.html?ref=' + encodeURIComponent(g.media_ref) + '" title="' + esc(g.name) + '">' +
        '<img src="' + esc(g.background_image || '/img/no-image.svg') + '" alt="' + esc(g.name) + '" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
      '</a>' +
      '<div class="dash-upnext-info">' +
        catBadge(mt) +
        '<a class="dash-upnext-name" href="title.html?ref=' + encodeURIComponent(g.media_ref) + '">' + esc(g.name) + '</a>' +
        infoHtml +
      '</div>' +
    '</div>';
  }

  function renderContinue() {
    var host = document.getElementById('dashContinue');
    if (!host) return;
    var items = continueItems();
    if (!items.length) { host.innerHTML = ''; return; }
    host.innerHTML = '<section class="dash-row"><h2 class="dash-row-title">Continue</h2>' +
      '<div class="dash-upnext">' + items.map(continueCardHtml).join('') + '</div></section>';
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
        body: JSON.stringify({ status: status, score: g.score == null ? null : g.score, progress: next })
      });
      if (r.ok) {
        g.progress = next; g.status = status; g.updated_at = new Date().toISOString();
        renderContinue();
        if (typeof toast === 'function') toast(next >= g.episode_count ? '“' + g.name + '” completed!' : 'Marked episode ' + next, 'success');
      } else {
        btn.disabled = false;
        if (typeof toast === 'function') toast('Could not update progress.', 'error');
      }
    } catch (_) { btn.disabled = false; }
  });

  // ── Library counts (feeds the hero pills) ────────────────────────────────
  function computeCatCounts() {
    var byCat = { movie: 0, series: 0, anime: 0, game: 0 };
    libCache.forEach(function (g) {
      var mt = g.media_type || 'game';
      if (byCat[mt] != null) byCat[mt]++;
    });
    return byCat;
  }

  function completedThisWeek() {
    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return libCache.filter(function (g) {
      return g.status === 'completed' && g.updated_at && new Date(g.updated_at).getTime() >= weekAgo;
    }).length;
  }

  // ── Recent ratings ───────────────────────────────────────────────────────
  function renderRatings() {
    var host = document.getElementById('dashRatings');
    if (!host) return;
    var rated = libCache
      .filter(function (g) { return g.score != null; })
      .sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })
      .slice(0, 14);
    if (!rated.length) { host.innerHTML = ''; return; }
    var cards = rated.map(function (g) {
      return posterCard({ id: g.media_ref, name: g.name, background_image: g.background_image, userScore: Number(g.score) });
    }).join('');
    host.innerHTML = rowShell('Recent ratings', cards, null, { href: 'profile.html', text: 'Your profile' });
    if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(host);
  }

  // ── Social: similar taste + friends' activity, small and skippable ──────
  function activityVerb(a) {
    var title = '<strong>' + esc(a.media.name) + '</strong>';
    var isGame = a.media.media_type === 'game';
    if (a.score != null) return 'rated ' + title + ' ' + a.score + '/10';
    if (a.status === 'completed') return (isGame ? 'finished playing ' : 'finished watching ') + title;
    if (a.status === 'playing') {
      if (isGame) return 'is playing ' + title;
      var episodic = a.media.media_type === 'series' || a.media.media_type === 'anime';
      if (episodic && a.progress && a.media.episode_count) return 'is on episode ' + a.progress + ' of ' + a.media.episode_count + ' of ' + title;
      return 'is watching ' + title;
    }
    return 'added ' + title;
  }

  function timeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  async function loadSocial() {
    var host = document.getElementById('dashSocial');
    if (!host) return;
    var results = await Promise.all([
      api('/discover/similar?limit=6').then(function (r) { return r.ok ? r.json() : { users: [] }; }).catch(function () { return { users: [] }; }),
      api('/following/activity?limit=5').then(function (r) { return r.ok ? r.json() : { activity: [] }; }).catch(function () { return { activity: [] }; })
    ]);
    var people = results[0].users || [];
    var activity = results[1].activity || [];
    if (!people.length && !activity.length) { host.innerHTML = ''; return; }

    var peopleHtml = people.length
      ? '<div class="dash-social-panel"><h3 class="dash-social-h">People with similar taste</h3>' +
          '<div class="pf-people">' + people.map(function (u) {
            var name = u.display_name || u.username;
            var avatar = u.avatar_url || ('https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&size=96&background=475569&color=fff&bold=true');
            return '<a class="pf-person" href="userProfile.html?userId=' + encodeURIComponent(u.id) + '">' +
              '<img src="' + esc(avatar) + '" alt="" loading="lazy">' +
              '<span class="pf-person-name">' + esc(name) + '</span>' +
              '<span class="pf-person-pct">' + Number(u.similarity.percent) + '%</span>' +
            '</a>';
          }).join('') + '</div></div>'
      : '';

    var activityHtml = activity.length
      ? '<div class="dash-social-panel"><h3 class="dash-social-h">Friends are up to</h3>' +
          activity.slice(0, 5).map(function (a) {
            var name = a.user.display_name || a.user.username;
            var href = a.media.media_ref ? 'title.html?ref=' + encodeURIComponent(a.media.media_ref) : (PAGE_FOR[a.media.media_type] || 'home.html');
            var thumb = a.media.background_image
              ? '<img class="activity-thumb" src="' + esc(a.media.background_image) + '" alt="" loading="lazy">'
              : '<span class="activity-thumb activity-thumb-empty"></span>';
            return '<a class="activity-item" href="' + href + '">' +
              '<img class="activity-avatar" src="' + esc(a.user.avatar_url || ('https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&size=64&background=475569&color=fff&bold=true')) + '" alt="">' +
              '<span class="activity-text">' +
                '<span class="activity-line"><span class="activity-user">' + esc(name) + '</span> ' + activityVerb(a) + '</span>' +
                '<span class="activity-time">' + timeAgo(a.updated_at) + '</span>' +
              '</span>' + thumb + '</a>';
          }).join('') + '</div>'
      : '';

    host.innerHTML = '<section class="dash-row"><div class="dash-social">' + peopleHtml + activityHtml + '</div></section>';
  }

  // ── Trending & Upcoming: All/Movies/Shows/Anime/Games tabs over one row ──
  // Same shape drives both - only the request body (and heading) differ - so
  // one setup function serves both sections instead of two near-duplicate
  // copies. Every category is fetched once up front; switching tabs re-renders
  // from what's already in hand, no extra request per click.
  var SOURCES = [
    { cat: 'movie',  endpoint: '/tmdb/movies' },
    { cat: 'series', endpoint: '/tmdb/series' },
    { cat: 'anime',  endpoint: '/kitsu/anime' },
    { cat: 'game',   endpoint: '/igdb/games' }
  ];
  var TAB_ORDER = ['all', 'movie', 'series', 'anime', 'game'];
  var TAB_LABEL = { all: 'All', movie: 'Movies', series: 'Shows', anime: 'Anime', game: 'Games' };

  function normalizeList(cat, arr) {
    if (!Array.isArray(arr)) return [];
    if (cat === 'game') {
      return arr.map(function (g) {
        var cover = (g.cover && g.cover.url) ? ('https:' + String(g.cover.url).replace('t_thumb', 't_cover_big')) : (g.background_image || null);
        return { id: 'igdb_' + g.id, name: g.name, background_image: cover, rating: g.total_rating ? Number((g.total_rating / 20).toFixed(1)) : null };
      }).filter(function (x) { return x.name && x.background_image; });
    }
    return arr.map(function (m) {
      return { id: m.id, name: m.name, background_image: m.background_image, rating: m.rating };
    }).filter(function (x) { return x.name && x.background_image; });
  }

  // Round-robin across categories so the "All" tab reads as one mixed shelf
  // rather than four blocks glued together.
  function interleave(lists) {
    var out = [];
    var max = Math.max.apply(null, lists.map(function (l) { return l.length; }).concat([0]));
    for (var i = 0; i < max; i++) lists.forEach(function (l) { if (l[i]) out.push(l[i]); });
    return out;
  }

  function initDiscoverySection(hostId, title, bodyExtra) {
    var host = document.getElementById(hostId);
    if (!host) return;
    var listsByCat = {};
    var activeTab = 'all';

    function itemsFor(tab) {
      if (tab === 'all') return interleave(CAT_ORDER.map(function (c) { return listsByCat[c] || []; })).slice(0, 20);
      return (listsByCat[tab] || []).slice(0, 20);
    }

    function renderRow() {
      var section = host.querySelector('.dash-row');
      var scroller = host.querySelector('.dash-scroller');
      if (!section || !scroller) return;
      // Neutral on All; the selected category's own color otherwise - reuses
      // the same [data-cat] accent tokens the nav tabs use, so the active tab
      // pill and the row's title dot pick up the right color automatically.
      if (activeTab === 'all') delete section.dataset.cat;
      else section.dataset.cat = CAT_FOR[activeTab];
      var items = itemsFor(activeTab);
      scroller.innerHTML = items.length ? items.map(posterCard).join('') : '<p class="dash-empty">Nothing to show yet.</p>';
      if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(host);
      host.querySelectorAll('.dash-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.cat === activeTab); });
    }

    host.innerHTML = '<section class="dash-row"><h2 class="dash-row-title">' + esc(title) + '</h2>' +
      '<div class="dash-tabs">' + TAB_ORDER.map(function (t) {
        return '<button type="button" class="dash-tab' + (t === 'all' ? ' active' : '') + '" data-cat="' + t + '">' + esc(TAB_LABEL[t]) + '</button>';
      }).join('') + '</div>' +
      '<div class="dash-scroller">' + skelRow() + '</div></section>';

    host.querySelectorAll('.dash-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (activeTab === btn.dataset.cat) return;
        activeTab = btn.dataset.cat;
        renderRow();
      });
    });

    Promise.all(SOURCES.map(function (s) {
      var body = Object.assign({ limit: 20 }, bodyExtra);
      return api(s.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    })).then(function (results) {
      SOURCES.forEach(function (s, i) { listsByCat[s.cat] = normalizeList(s.cat, results[i]); });
      var anyData = CAT_ORDER.some(function (c) { return (listsByCat[c] || []).length; });
      if (!anyData) { host.innerHTML = ''; return; }
      renderRow();
    });
  }

  function loadTrending() {
    initDiscoverySection('dashTrending', 'Trending now', { sort: 'popularity' });
  }

  function loadUpcoming() {
    initDiscoverySection('dashUpcoming', 'Popular upcoming', { comingSoon: true });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  async function loadLibraryAndRenderPersonalSections() {
    try {
      var r = await api('/user/games');
      if (!r.ok) { renderHero(0, null); return; }
      var d = await r.json();
      libCache = d.games || [];
      renderHero(completedThisWeek(), computeCatCounts());
      renderContinue();
      renderRatings();
    } catch (_) {
      renderHero(0, null);
    }
    // Lower-priority sections load after the personal ones have painted.
    loadSocial();
    loadTrending();
    loadUpcoming();
  }

  if (isGuest) {
    renderHero(0, null);
    loadTrending();
    loadUpcoming();
  } else {
    loadLibraryAndRenderPersonalSections();
  }
})();
