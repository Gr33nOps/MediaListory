/* Home dashboard: a personal control panel, not a trending page.

   Everything a signed-in user sees below the hero comes from ONE bulk fetch
   (/api/user/games) plus a handful of small, capped calls for the sections
   that need data this app doesn't already have client-side (similar taste,
   friends' activity, trending, genre-based recommendations). That single
   library fetch also seeds the shared library index (setLibraryEntry) so the
   quick-add plus/tick on every card below is correct without a second
   /user/games/refs round trip.

   Section order follows what the user actually wants to see first: what they
   are in the middle of, a compact snapshot of their library, what they've
   rated lately, a couple of genre-shaped recommendations drawn from that
   rating history, a small social read, and - last, smallest - generic
   trending, so it never competes with the user's own activity for attention. */
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
  var LABEL_SINGULAR = { movie: 'Movie', series: 'Show', anime: 'Anime', game: 'Game' };

  function esc(s) {
    if (typeof window.esc === 'function') return window.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function catBadge(mediaType) {
    return '<span class="cl-cat-badge" data-cat="' + mediaType + '">' + esc(LABEL_SINGULAR[mediaType] || 'Game') + '</span>';
  }

  // Quick-add needs the full item (provider ids, genres) to save a title it has
  // never fetched details for, so every card that offers quick-add registers
  // its source object here rather than having the button re-derive it from the
  // DOM, which would lose the provider-specific fields the mixed grids need.
  var itemsByRef = {};

  // Poster card shared by Recent ratings, Recommendations and Trending. `opts`
  // picks which overlay this particular row wants - a title never needs both a
  // catalog rating and the user's own score at once, and quick-add only makes
  // sense where the item might not be owned yet.
  function posterCard(item, opts) {
    opts = opts || {};
    var ref = item.id;
    var overlay = '';
    if (opts.userScore != null) {
      var word = (typeof window.scoreWord === 'function') ? window.scoreWord(item.userScore) : '';
      overlay = '<span class="card-rating" title="Your score">' + esc(item.userScore) + (word ? ' · ' + esc(word) : '') + '</span>';
    } else if (item.rating) {
      overlay = '<span class="card-rating">★ ' + esc(Number(item.rating).toFixed(1)) + '</span>';
    }
    var quick = '';
    if (opts.quickAdd && window.MGLQuickAdd) {
      itemsByRef[ref] = item;
      quick = window.MGLQuickAdd.buttonHtml(ref, typeof libraryEntry === 'function' && !!libraryEntry(ref));
    }
    var badge = opts.badge ? catBadge(item.media_type) : '';
    var poster = '<div class="dash-card-poster">' +
        '<img src="' + esc(item.background_image || '/img/no-image.svg') + '" alt="' + esc(item.name) + '" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' + overlay + quick +
      '</div>' +
      (badge ? '<div class="dash-card-tag">' + badge + '</div>' : '') +
      '<span class="dash-card-name">' + esc(item.name) + '</span>';
    // A card with a quick-add button cannot itself be an <a> - a button nested
    // inside a link is invalid and mangles screen-reader and keyboard behaviour.
    // It becomes a proper activatable card instead, same as every browse grid.
    if (quick) {
      return '<div class="dash-card" data-ref="' + esc(ref) + '" ' + (typeof cardAttrs === 'function' ? cardAttrs('View details for ' + item.name) : 'role="button" tabindex="0"') + '>' + poster + '</div>';
    }
    return '<a class="dash-card" href="title.html?ref=' + encodeURIComponent(ref) + '" title="' + esc(item.name) + '">' + poster + '</a>';
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
  var SEARCH_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  function searchTriggerHtml() {
    return '<button type="button" class="dash-hero-search" id="dashSearchBtn" aria-label="Search all media">' +
      SEARCH_SVG + 'Search movies, shows, anime, games…' +
    '</button>';
  }

  function renderHero(weekCount, totalCount) {
    var el = document.getElementById('dashHero');
    if (!el) return;
    if (isGuest) {
      el.innerHTML = '<div class="dash-hero-inner">' +
        '<h2 class="dash-hero-title">Everything you watch and play, in one place</h2>' +
        '<p class="dash-hero-sub">Track movies, shows, anime, and games. Rate them, follow your episode progress, and keep one library.</p>' +
        searchTriggerHtml() +
        '<div class="dash-hero-cta">' +
          '<a class="btn btn-primary" href="auth.html">Create a free account</a>' +
          '<a class="btn btn-secondary" href="movies.html">Browse without an account</a>' +
        '</div>' +
      '</div>';
    } else {
      var name = (user && (user.display_name || user.username)) || 'back';
      var sub;
      if (weekCount > 0) {
        sub = 'You’ve finished ' + weekCount + (weekCount === 1 ? ' title' : ' titles') + ' this week. Pick up where you left off, or find something new below.';
      } else if (totalCount === 0) {
        sub = 'Your library is empty. Search for something you’ve watched or played to start tracking it.';
      } else {
        sub = 'Pick up where you left off, or find something new below.';
      }
      el.innerHTML = '<div class="dash-hero-inner">' +
        '<h2 class="dash-hero-title">Welcome back, ' + esc(name) + '</h2>' +
        '<p class="dash-hero-sub">' + esc(sub) + '</p>' +
        searchTriggerHtml() +
      '</div>';
    }
    var searchBtn = document.getElementById('dashSearchBtn');
    if (searchBtn) searchBtn.addEventListener('click', function () {
      if (typeof window.__openGlobalSearch === 'function') window.__openGlobalSearch();
    });
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
    return '<div class="dash-upnext-card" data-cat="' + mt + '">' +
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
        renderOverview();
        if (typeof toast === 'function') toast(next >= g.episode_count ? '“' + g.name + '” completed!' : 'Marked episode ' + next, 'success');
      } else {
        btn.disabled = false;
        if (typeof toast === 'function') toast('Could not update progress.', 'error');
      }
    } catch (_) { btn.disabled = false; }
  });

  // ── Library overview (compact) ──────────────────────────────────────────
  function computeOverview() {
    var byCat = { movie: 0, series: 0, anime: 0, game: 0 };
    var byStatus = { playing: 0, completed: 0, plan_to_play: 0, on_hold: 0, dropped: 0 };
    var scores = [];
    var thisYear = new Date().getFullYear();
    var completedThisYear = 0;
    libCache.forEach(function (g) {
      var mt = g.media_type || 'game';
      if (byCat[mt] != null) byCat[mt]++;
      if (byStatus[g.status] != null) byStatus[g.status]++;
      if (g.score != null) scores.push(Number(g.score));
      if (g.status === 'completed' && g.updated_at && new Date(g.updated_at).getFullYear() === thisYear) completedThisYear++;
    });
    var avg = scores.length ? (scores.reduce(function (a, b) { return a + b; }, 0) / scores.length) : null;
    return { byCat: byCat, byStatus: byStatus, avg: avg, completedThisYear: completedThisYear, total: libCache.length };
  }

  function completedThisWeek() {
    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return libCache.filter(function (g) {
      return g.status === 'completed' && g.updated_at && new Date(g.updated_at).getTime() >= weekAgo;
    }).length;
  }

  function renderOverview() {
    var host = document.getElementById('dashOverview');
    if (!host) return;
    if (!libCache.length) { host.innerHTML = ''; return; }
    var s = computeOverview();
    var tiles = [
      { value: s.total, label: 'Tracked' },
      { value: s.byStatus.playing, label: 'In progress' },
      { value: s.byStatus.completed, label: 'Completed' },
      { value: s.avg != null ? s.avg.toFixed(1) : '–', label: 'Average score' }
    ];
    var catOrder = [['movie', 'Movies'], ['series', 'Shows'], ['anime', 'Anime'], ['game', 'Games']];
    host.innerHTML =
      '<section class="dash-row">' +
        '<div class="dash-section-head"><h2 class="dash-row-title">Your library</h2>' +
          '<a class="dash-row-link" href="library.html">View library</a></div>' +
        '<div class="stat-tiles dash-stat-tiles">' + tiles.map(function (t) {
          return '<div class="stat-tile"><span class="stat-tile-value">' + t.value + '</span><span class="stat-tile-label">' + t.label + '</span></div>';
        }).join('') + '</div>' +
        '<div class="cat-breakdown">' + catOrder.map(function (o) {
          return '<a class="cat-stat" data-cat="' + o[0] + '" href="library.html" title="View your ' + o[1] + '">' +
            '<span class="cs-num">' + s.byCat[o[0]] + '</span><span class="cs-label">' + o[1] + '</span></a>';
        }).join('') + '</div>' +
      '</section>';
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
      return posterCard({ id: g.media_ref, name: g.name, background_image: g.background_image, userScore: Number(g.score) }, { userScore: g.score });
    }).join('');
    host.innerHTML = rowShell('Recent ratings', cards, null, { href: 'profile.html', text: 'Your profile' });
    if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(host);
  }

  // ── Recommendations: "Because you like <genre>" ─────────────────────────
  var REC_SOURCE = {
    movie:  { endpoint: '/tmdb/movies' },
    series: { endpoint: '/tmdb/series' },
    anime:  { endpoint: '/kitsu/anime' },
    game:   { endpoint: '/igdb/games' }
  };
  var MIN_RATED_FOR_RECS = 5;

  // Highest-weighted genre among what this user actually rated highly in one
  // category, or null when there is not enough rated history to say anything
  // honest about taste yet.
  function topGenreFor(mediaType) {
    var rated = libCache.filter(function (g) { return (g.media_type || 'game') === mediaType && g.score != null; });
    if (rated.length < MIN_RATED_FOR_RECS) return null;
    var weights = {};
    rated.forEach(function (g) {
      (g.genres || []).forEach(function (gen) {
        var name = gen && gen.name;
        if (!name) return;
        weights[name] = (weights[name] || 0) + Number(g.score);
      });
    });
    var best = null;
    Object.keys(weights).forEach(function (name) {
      if (!best || weights[name] > weights[best]) best = name;
    });
    return best ? { genre: best, ratedCount: rated.length } : null;
  }

  function normalizeRecList(cat, arr) {
    if (!Array.isArray(arr)) return [];
    if (cat === 'game') {
      return arr.map(function (g) {
        var cover = (g.cover && g.cover.url) ? ('https:' + String(g.cover.url).replace('t_thumb', 't_cover_big')) : (g.background_image || null);
        return { id: 'igdb_' + g.id, igdb_id: g.id, media_type: 'game', name: g.name, background_image: cover, rating: g.total_rating ? Number((g.total_rating / 20).toFixed(1)) : null };
      }).filter(function (x) { return x.name && x.background_image; });
    }
    return arr.map(function (m) {
      return {
        id: m.id, media_type: m.media_type || cat, name: m.name, background_image: m.background_image, rating: m.rating,
        tmdb_id: m.tmdb_id || null, provider_id: m.provider_id || null
      };
    }).filter(function (x) { return x.name && x.background_image; });
  }

  async function loadRecommendations() {
    var host = document.getElementById('dashRecs');
    if (!host) return;
    // Priority order chosen for how strong the signal usually is (episodic
    // media tends to accumulate more rated titles than games), but only the
    // categories that actually clear the confidence floor are used.
    var candidates = ['series', 'anime', 'movie', 'game']
      .map(function (cat) { var g = topGenreFor(cat); return g ? { cat: cat, genre: g.genre, ratedCount: g.ratedCount } : null; })
      .filter(Boolean)
      .sort(function (a, b) { return b.ratedCount - a.ratedCount; })
      .slice(0, 2);
    if (!candidates.length) { host.innerHTML = ''; return; }

    host.innerHTML = candidates.map(function (c) {
      return rowShell('Because you like ' + c.genre + ' ' + LABEL[c.cat], skelRow(), CAT_FOR[c.cat]);
    }).join('');

    var results = await Promise.all(candidates.map(function (c) {
      return api(REC_SOURCE[c.cat].endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ genre: c.genre, sort: 'rating', limit: 16 })
      }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    }));

    var html = '';
    candidates.forEach(function (c, i) {
      var items = normalizeRecList(c.cat, results[i])
        .filter(function (it) { return typeof libraryEntry !== 'function' || !libraryEntry(it.id); })
        .slice(0, 14);
      if (!items.length) return;
      var cards = items.map(function (it) { return posterCard(it, { quickAdd: true }); }).join('');
      html += rowShell('Because you like ' + c.genre + ' ' + LABEL[c.cat], cards, CAT_FOR[c.cat]);
    });
    host.innerHTML = html;
    if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(host);
    bindQuickAdd(host);
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

  // ── Trending: one mixed row instead of four repeated ones ───────────────
  var TRENDING = [
    { cat: 'movie',  endpoint: '/tmdb/movies' },
    { cat: 'series', endpoint: '/tmdb/series' },
    { cat: 'anime',  endpoint: '/kitsu/anime' },
    { cat: 'game',   endpoint: '/igdb/games' }
  ];

  function normalizeList(cat, arr) {
    if (!Array.isArray(arr)) return [];
    if (cat === 'game') {
      return arr.map(function (g) {
        var cover = (g.cover && g.cover.url) ? ('https:' + String(g.cover.url).replace('t_thumb', 't_cover_big')) : (g.background_image || null);
        return { id: 'igdb_' + g.id, igdb_id: g.id, media_type: 'game', name: g.name, background_image: cover, rating: g.total_rating ? Number((g.total_rating / 20).toFixed(1)) : (g.rating || null) };
      }).filter(function (x) { return x.name && x.background_image; });
    }
    return arr.map(function (m) {
      return {
        id: m.id, media_type: m.media_type || cat, name: m.name, background_image: m.background_image, rating: m.rating,
        tmdb_id: m.tmdb_id || null, provider_id: m.provider_id || null
      };
    }).filter(function (x) { return x.name && x.background_image; });
  }

  // Round-robin across categories so the row reads as one mixed shelf rather
  // than four blocks glued together.
  function interleave(lists) {
    var out = [];
    var max = Math.max.apply(null, lists.map(function (l) { return l.length; }).concat([0]));
    for (var i = 0; i < max; i++) {
      lists.forEach(function (l) { if (l[i]) out.push(l[i]); });
    }
    return out;
  }

  async function loadTrending() {
    var host = document.getElementById('dashTrending');
    if (!host) return;
    host.innerHTML = rowShell('Trending now', skelRow());
    var results = await Promise.all(TRENDING.map(function (t) {
      return api(t.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sort: 'popularity', limit: 10 }) })
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    }));
    var lists = TRENDING.map(function (t, i) { return normalizeList(t.cat, results[i]); });
    var items = interleave(lists).slice(0, 20);
    if (!items.length) { host.innerHTML = ''; return; }
    var cards = items.map(function (it) { return posterCard(it, { badge: true, quickAdd: true }); }).join('');
    host.innerHTML = rowShell('Trending now', cards);
    if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(host);
    bindQuickAdd(host);
  }

  // The container holds several media types at once (Trending, Recommendations),
  // so the `kind` given to bind() is nominal - toGameData resolves the real one
  // per-item from item.media_type, which every entry in itemsByRef carries.
  function bindQuickAdd(host) {
    if (window.MGLQuickAdd) {
      host.querySelectorAll('.dash-scroller').forEach(function (scroller) {
        window.MGLQuickAdd.bind(scroller, function (ref) { return itemsByRef[ref] || null; }, 'movie');
      });
    }
    // Cards with a quick-add button are role="button" divs, not links (see
    // posterCard), so opening the title page is wired the same way every other
    // grid in the app does it: bindActivatableCards ignores clicks that land on
    // the nested button.
    if (typeof bindActivatableCards === 'function' && !host.__dashActivateBound) {
      host.__dashActivateBound = true;
      bindActivatableCards(host, '.dash-card[data-ref]', function (card) {
        window.location.href = 'title.html?ref=' + encodeURIComponent(card.dataset.ref);
      });
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  async function loadLibraryAndRenderPersonalSections() {
    try {
      var r = await api('/user/games');
      if (!r.ok) { renderHero(0); return; }
      var d = await r.json();
      libCache = d.games || [];
      // Seed the shared library index from what we already have, so quick-add
      // ticks are correct everywhere below without a second network round trip.
      if (typeof setLibraryEntry === 'function') {
        libCache.forEach(function (g) {
          setLibraryEntry(g.media_ref, { id: g.game_id, status: g.status, score: g.score });
        });
      }
      renderHero(completedThisWeek(), libCache.length);
      renderContinue();
      renderOverview();
      renderRatings();
    } catch (_) {
      renderHero(0);
    }
    // Lower-priority sections load after the personal ones have painted.
    loadRecommendations();
    loadSocial();
    loadTrending();
  }

  if (isGuest) {
    renderHero(0);
    loadTrending();
  } else {
    loadLibraryAndRenderPersonalSections();
  }
})();
