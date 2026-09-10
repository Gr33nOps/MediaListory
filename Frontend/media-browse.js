/**
 * Shared browse/search/detail/track logic for Movies + Series (TMDB) and Anime (Kitsu).
 * Mirrors the Games browse UX (home.js) but drives the normalized /api proxies.
 * Each page sets window.MEDIA_TYPE ('movie' | 'series' | 'anime') before loading this.
 */
(function () {
  var TYPES = {
    movie:  { endpoint: '/tmdb/movies', genres: '/tmdb/genres', genresBody: { media_type: 'movie' },  noun: 'movies' },
    series: { endpoint: '/tmdb/series', genres: '/tmdb/genres', genresBody: { media_type: 'series' }, noun: 'shows' },
    anime:  { endpoint: '/kitsu/anime', genres: '/kitsu/genres', genresBody: {},                      noun: 'anime' }
  };
  var MEDIA_TYPE = TYPES[window.MEDIA_TYPE] ? window.MEDIA_TYPE : 'movie';
  var CFG = TYPES[MEDIA_TYPE];
  var ENDPOINT = CFG.endpoint;
  var NOUN = CFG.noun;

  // Which filter controls exist per category, mapping DOM id -> request key.
  // Only these keys are ever sent, so no API gets a parameter meant for another.
  var FILTER_CONFIG = {
    movie:  [
      { id: 'genre',    key: 'genre' },
      { id: 'year',     key: 'year' },
      { id: 'minRating', key: 'minRating' },
      { id: 'runtime',  key: 'runtime' },
      { id: 'language', key: 'language' }
    ],
    series: [
      { id: 'genre',    key: 'genre' },
      { id: 'year',     key: 'year' },
      { id: 'minRating', key: 'minRating' },
      { id: 'language', key: 'language' },
      { id: 'statusFilter', key: 'status' },
      { id: 'typeFilter',   key: 'type' }
    ],
    anime:  [
      { id: 'genre',    key: 'genre' },
      { id: 'year',     key: 'year' },
      { id: 'season',   key: 'season' },
      { id: 'subtype',  key: 'subtype' },
      { id: 'statusFilter', key: 'status' },
      { id: 'ageRating', key: 'ageRating' }
    ]
  };
  var FILTERS = FILTER_CONFIG[MEDIA_TYPE] || [];

  var currentFilters = {};
  var currentSort = 'popularity';
  var currentSortOrder = 'desc';
  var currentPage = 1;
  var perPage = 24;
  var isLoading = false;
  var hasMore = true;
  var lastResults = {}; // ref -> normalized media object (for add-to-library)

  function byId(id) { return document.getElementById(id); }

  function guest() { return typeof getToken === 'function' ? !getToken() : true; }

  function promptSignIn(message) {
    if (typeof toast === 'function') toast(message || 'Create a free account to save this.', 'info');
    setTimeout(function () {
      window.location.href = (typeof authUrlWithNext === 'function' ? authUrlWithNext() : 'auth.html');
    }, 900);
  }

  (async function boot() {
    if (typeof ensureSession === 'function') { try { await ensureSession(); } catch (_) {} }
    // Guest mode: browse movies/series without an account. Saving prompts sign-in.
    if (!guest()) {
      try {
        var res = await apiFetch('/auth/me', { cache: 'no-store' });
        if (res.status === 401 || res.status === 403) { logout(); return; }
      } catch (_) {}
    }
    initPage();
  })();

  function initPage() {
    onClick('searchBtn', doSearch);
    onClick('filterBtn', function () { byId('filterSection').classList.toggle('hidden'); });
    onClick('applyFiltersBtn', applyFilters);
    onClick('resetFiltersBtn', resetFilters);
    onClick('prevPageBtn', prevPage);
    onClick('nextPageBtn', nextPage);

    var searchInput = byId('searchInput');
    if (searchInput) {
      searchInput.addEventListener('keypress', function (e) { if (e.key === 'Enter') doSearch(); });
      // Live search: results update as you type (debounced), like the global bar.
      var searchDebounce;
      searchInput.addEventListener('input', function () {
        clearTimeout(searchDebounce);
        var term = searchInput.value.trim();
        searchDebounce = setTimeout(function () {
          if (term.length === 0 || term.length >= 2) doSearch();
        }, 350);
      });
    }

    var sortBy = byId('sortBy');
    if (sortBy) {
      sortBy.value = 'popularity-desc';
      sortBy.addEventListener('change', function () {
        var v = sortBy.value;
        if (v === 'coming-soon') { currentSort = 'coming'; currentSortOrder = 'soon'; }
        else {
          var i = v.lastIndexOf('-');
          currentSort = v.substring(0, i);
          currentSortOrder = v.substring(i + 1);
        }
        currentPage = 1; hasMore = true; window.scrollTo(0, 0); fetchMedia(true);
      });
    }

    if (typeof bindActivatableCards === 'function') {
      bindActivatableCards(document, '.game-card', function (card) { showDetails(card.dataset.gameId); });
    }

    /* The plus on a card saves straight from the grid. It sits on top of the
       card's own activation, so it stops the click before the card can
       navigate - clicking anywhere else still opens the full page. */
    if (window.MGLQuickAdd) {
      window.MGLQuickAdd.bind(byId('searchResults'), function (ref) { return lastResults[ref]; }, MEDIA_TYPE);
    }

    // Card blurbs can still expand in place on the grid.
    document.addEventListener('click', function (e) {
      if (!e.target.classList.contains('show-more-btn')) return;
      e.stopPropagation();
      var wrap = e.target.closest('.game-card-desc');
      if (!wrap) return;
      var shortEl = wrap.querySelector('.desc-short');
      var fullEl = wrap.querySelector('.desc-full');
      var expanding = fullEl && fullEl.classList.contains('hidden');
      if (shortEl) shortEl.classList.toggle('hidden', expanding);
      if (fullEl) fullEl.classList.toggle('hidden', !expanding);
      e.target.textContent = expanding ? 'Show less' : 'Show more';
    });

    loadGenres();
    populateDynamicFilters();
    fetchMedia(true);

    // Deep link from the dashboard or a shared card. Titles have their own page
    // now, so ?open= forwards to it rather than opening anything here.
    var openRef = new URLSearchParams(location.search).get('open');
    if (openRef && /^[a-z]+_[a-z_]*\d+$/i.test(openRef)) {
      showDetails(openRef);
    }
  }

  function onClick(id, fn) { var el = byId(id); if (el) el.addEventListener('click', fn); }

  async function loadGenres() {
    var select = byId('genre');
    if (!select) return;
    try {
      var r = await apiFetch(CFG.genres, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(CFG.genresBody)
      });
      if (!r.ok) return;
      var genres = await r.json();
      var opts = '<option value="">All Genres</option>';
      (genres || []).forEach(function (g) {
        opts += '<option value="' + esc(g.name) + '">' + esc(g.name) + '</option>';
      });
      select.innerHTML = opts;
    } catch (_) {}
  }

  /* The server folds an anime franchise into one tile, but it can only see the
     page in front of it. Attack on Titan's parent can sit at the end of page 1
     and The Final Season at the top of page 2, where there is no parent left to
     fold it into - so the wall of near-identical seasons comes back one page
     later. Remembering which franchises have already been shown closes that.

     Only an entry the server marked as a sequel is ever dropped, so a title that
     merely shares a stem still gets its own tile. Page 1 starts fresh, which is
     also what makes a new search or filter start fresh. */
  var seenFranchises = {};

  function foldSeenFranchises(items) {
    if (MEDIA_TYPE !== 'anime') return items;
    if (currentPage === 1) seenFranchises = {};
    return items.filter(function (m) {
      var key = m && m.franchise_key;
      if (!key) return true;
      if (m.franchise_sequel && seenFranchises[key]) return false;
      seenFranchises[key] = true;
      return true;
    });
  }



  /* People matching the search, above the titles.

     Searching a cast member's name otherwise returns whatever films happen to
     mention them, which is rarely the thing being looked for. TMDB is the only
     provider here with a people index, so this runs for films and shows and is
     simply absent for anime and games - a row that never fills is worse than no
     row. It never blocks or breaks the title results beside it. */
  async function loadPeopleFor(term) {
    var host = byId('peopleFound');
    if (!host) {
      var results = byId('searchResults');
      if (!results || !results.parentNode) return;
      host = document.createElement('section');
      host.id = 'peopleFound';
      host.className = 'people-found';
      host.hidden = true;
      results.parentNode.insertBefore(host, results);
    }

    if (!term || (MEDIA_TYPE !== 'movie' && MEDIA_TYPE !== 'series')) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    try {
      var r = await apiFetch('/people/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: term })
      });
      if (!r.ok) { host.hidden = true; host.innerHTML = ''; return; }
      var people = await r.json();
      if (!Array.isArray(people) || !people.length) { host.hidden = true; host.innerHTML = ''; return; }

      host.innerHTML = '<h2 class="detail-h">People</h2><div class="people-strip">' +
        people.map(function (p) {
          return '<a class="people-strip-card" href="person.html?ref=' + esc(p.ref) + '">' +
            '<img src="' + esc(p.image || '/img/no-image.svg') + '" alt="" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
            '<span class="people-strip-name">' + esc(p.name) + '</span>' +
            (p.note ? '<span class="people-strip-note">' + esc(p.note) + '</span>' : '') +
          '</a>';
        }).join('') + '</div>';
      host.hidden = false;
    } catch (e) {
      host.hidden = true;
      host.innerHTML = '';
    }
  }

  function skeletonCards(n) {
    var one = '<div class="skeleton-card"><div class="skeleton skel-poster"></div>' +
      '<div class="skel-info"><div class="skeleton skel-line w80"></div><div class="skeleton skel-line w50"></div></div></div>';
    return new Array(n).join(one) + one;
  }

  async function fetchMedia(replace) {
    if (isLoading) return;
    isLoading = true;
    var loading = byId('loadingIndicator');
    // Show skeleton cards in place of the results while a fresh query loads;
    // the spinner is only used for the (rare) append case.
    if (replace) {
      if (loading) loading.style.display = 'none';
      byId('searchResults').innerHTML = skeletonCards(perPage || 12);
    } else if (loading) {
      loading.style.display = 'flex';
    }

    try {
      var offset = (currentPage - 1) * perPage;
      var isComing = currentSort === 'coming' && currentSortOrder === 'soon';
      var sortKey = isComing ? 'coming' : currentSort;

      var payload = {
        search: currentFilters.search || undefined,
        sort: sortKey,
        sortOrder: currentSortOrder,
        comingSoon: isComing,
        limit: perPage,
        offset: offset
      };
      // Only attach the filter keys this category actually supports.
      FILTERS.forEach(function (f) {
        if (currentFilters[f.key]) payload[f.key] = currentFilters[f.key];
      });

      var r = await apiFetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (typeof applyQueryStateNotice === 'function') applyQueryStateNotice(queryStateFrom(r));

      var data = await r.json();
      if (r.ok && Array.isArray(data)) {
        // Before rendering, so the first paint already carries the badges.
        if (typeof loadLibraryIndex === 'function') await loadLibraryIndex();
        data = foldSeenFranchises(data);
        data.forEach(function (m) { if (m && m.id) lastResults[m.id] = m; });
        /* Anime tiles collapse a franchise into one entry, so a short page no
           longer means the end of the results. The server sends the answer. */
        var moreHeader = r.headers.get('X-Has-More');
        hasMore = moreHeader === null ? data.length === perPage : moreHeader === '1';
        render(data, replace);
        updatePagination();
        if (data.length === 0 && replace) {
          byId('searchResults').innerHTML = '<div class="empty-state">' +
            esc(currentFilters.search ? ('No ' + NOUN + ' found for "' + currentFilters.search + '".') : ('No ' + NOUN + ' found.')) +
            '</div>';
        }
      } else {
        var msg = 'Could not load ' + NOUN + '.';
        if (r.status === 401) msg = 'Session expired - sign in again.';
        else if (r.status === 500 && data && data.error) msg = data.error;
        else if (typeof describeApiError === 'function') msg = describeApiError(r, data, msg);
        byId('searchResults').innerHTML = '<div class="empty-state">' + esc(msg) + '</div>';
        if (typeof toast === 'function') toast(msg, 'error');
      }
    } catch (err) {
      byId('searchResults').innerHTML = '<div class="empty-state">' + esc('Network error loading ' + NOUN + '.') + '</div>';
    } finally {
      isLoading = false;
      if (loading) loading.style.display = 'none';
    }
  }

  function render(items, replace) {
    var container = byId('searchResults');
    var html = items.map(function (m) {
      var imgSrc = m.background_image || '/img/no-image.svg';
      var releasedHtml = '';
      if (m.released) {
        var dateStr = new Date(m.released).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        releasedHtml = '<span class="game-card-date">' + esc(dateStr) + '</span>';
      }
      // Grid tiles stay poster-first: title + year only. Genres, synopsis and
      // the rest live in the detail modal, one click away.
      var label = 'View details for ' + (m.name || NOUN);
      var ratingHtml = m.rating ? '<span class="card-rating">★ ' + esc(Number(m.rating).toFixed(1)) + '</span>' : '';
      // Says "you already have this" before the user clicks in and adds it twice.
      var ownedHtml = typeof ownedBadgeHtml === 'function' ? ownedBadgeHtml(m.id) : '';
      // Saves from the grid without opening (and paying for) the full title.
      var quickHtml = window.MGLQuickAdd
        ? window.MGLQuickAdd.buttonHtml(m.id, typeof libraryEntry === 'function' && !!libraryEntry(m.id))
        : '';
      return '<div class="game-card" data-game-id="' + esc(m.id) + '" role="button" tabindex="0" aria-label="' + esc(label) + '">' +
        '<div class="game-image-wrapper">' +
          '<img src="' + esc(imgSrc) + '" alt="' + esc((m.name || NOUN) + ' cover') + '" class="game-image" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
          ratingHtml + ownedHtml + quickHtml +
        '</div>' +
        '<div class="game-info">' +
          '<div class="game-title">' + esc(m.name) + '</div>' +
          '<div class="game-card-meta">' + releasedHtml + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    if (replace) container.innerHTML = html;
    // nosemgrep: typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method -- html is assembled only from esc()-escaped values above
    else container.insertAdjacentHTML('beforeend', html);
  }
  /* Opening a title is a navigation, not an overlay.

     This used to build the whole detail view into a modal over the grid. A
     title now has its own address, so it can be linked, shared, opened in a new
     tab and left with the browser's own Back - and on a phone it is a page
     rather than a scrolling box inside one. title.js renders every category,
     which is also why the per-category copies of this went away.

     Every existing caller still works: the grid, the "More like this" cards,
     the series strip and the ?open= deep link all hand over a ref. */
  function showDetails(ref) {
    if (!ref) return;
    window.location.href = 'title.html?ref=' + encodeURIComponent(ref);
  }


  // The notice's "Clear search" needs a way back into this page's own reload.
  window.__clearSearch = function () { doSearch(); };

  function doSearch() {
    var term = byId('searchInput').value.trim();
    currentFilters.search = term;
    var sortBy = byId('sortBy');
    if (term) { if (sortBy) sortBy.value = 'popularity-desc'; currentSort = 'popularity'; currentSortOrder = 'desc'; }
    currentPage = 1; hasMore = true; window.scrollTo(0, 0); fetchMedia(true);
    loadPeopleFor(term);
  }

  function applyFilters() {
    var next = { search: currentFilters.search || '' };
    FILTERS.forEach(function (f) {
      var el = byId(f.id);
      if (el && el.value) next[f.key] = el.value;
    });
    currentFilters = next;
    currentPage = 1; hasMore = true; window.scrollTo(0, 0); fetchMedia(true);
  }

  // Reset clears only the filter controls; the search box and sort are left alone.
  function resetFilters() {
    FILTERS.forEach(function (f) { var el = byId(f.id); if (el) el.value = ''; });
    var kept = currentFilters.search || '';
    currentFilters = kept ? { search: kept } : {};
    currentPage = 1; hasMore = true; window.scrollTo(0, 0); fetchMedia(true);
  }

  // Populate the option lists that come from data rather than static markup:
  // a rolling year range for every category, and TMDB languages for movie/series.
  function populateDynamicFilters() {
    var yearSel = byId('year');
    if (yearSel && yearSel.options.length <= 1) {
      var now = new Date().getFullYear();
      var maxYear = MEDIA_TYPE === 'anime' ? now + 1 : now;
      var opts = '<option value="">' + (MEDIA_TYPE === 'anime' ? 'Any year' : 'Any year') + '</option>';
      for (var y = maxYear; y >= 1950; y--) opts += '<option value="' + y + '">' + y + '</option>';
      yearSel.innerHTML = opts;
    }

    var langSel = byId('language');
    if (langSel && (MEDIA_TYPE === 'movie' || MEDIA_TYPE === 'series')) {
      apiFetch('/tmdb/languages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }).then(function (r) { return r.ok ? r.json() : []; }).then(function (langs) {
        if (!Array.isArray(langs) || !langs.length) return;
        var opts = '<option value="">Any language</option>';
        langs.forEach(function (l) {
          opts += '<option value="' + esc(l.code) + '">' + esc(l.name) + '</option>';
        });
        langSel.innerHTML = opts;
      }).catch(function () {});
    }
  }

  function prevPage() {
    if (currentPage <= 1 || isLoading) return;
    currentPage--; window.scrollTo(0, 0); fetchMedia(true);
  }

  function nextPage() {
    if (!hasMore || isLoading) return;
    currentPage++; window.scrollTo(0, 0); fetchMedia(true);
  }

  function updatePagination() {
    var prev = byId('prevPageBtn'); var next = byId('nextPageBtn'); var info = byId('pageInfo');
    if (prev) prev.disabled = currentPage <= 1;
    if (next) next.disabled = !hasMore;
    if (info) info.textContent = 'Page ' + currentPage;
  }
})();
