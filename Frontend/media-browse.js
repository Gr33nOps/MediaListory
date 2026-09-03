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

  var currentFilters = {};
  var currentSort = 'popularity';
  var currentSortOrder = 'desc';
  var currentPage = 1;
  var perPage = 24;
  var isLoading = false;
  var hasMore = true;
  var lastResults = {}; // ref -> normalized media object (for add-to-library)
  var userCustomLists = [];

  var ANIME_STATUS_LABEL = {
    finished: 'Finished airing', current: 'Currently airing',
    upcoming: 'Upcoming', tba: 'To be announced', unreleased: 'Unreleased'
  };

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
    if (typeof bindModal === 'function') bindModal('gameModal', 'closeModalBtn');

    var searchInput = byId('searchInput');
    if (searchInput) {
      searchInput.addEventListener('keypress', function (e) { if (e.key === 'Enter') doSearch(); });
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

    document.addEventListener('click', function (e) {
      if (e.target.classList.contains('show-more-btn')) {
        e.stopPropagation();
        var wrap = e.target.closest('.game-card-desc, .game-detail-desc');
        if (!wrap) return;
        var shortEl = wrap.querySelector('.desc-short');
        var fullEl = wrap.querySelector('.desc-full');
        var expanding = fullEl && fullEl.classList.contains('hidden');
        if (shortEl) shortEl.classList.toggle('hidden', expanding);
        if (fullEl) fullEl.classList.toggle('hidden', !expanding);
        e.target.textContent = expanding ? 'Show less' : 'Show more';
        return;
      }
      if (e.target.classList.contains('add-to-list-btn')) {
        addToLibrary(e.target.dataset.gameId);
        return;
      }
      // Play trailer inline: swap the thumbnail facade for a lazy YouTube embed.
      var trailerEl = e.target.closest('.detail-trailer');
      if (trailerEl && trailerEl.dataset.yt) {
        var key = trailerEl.dataset.yt;
        trailerEl.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(key) +
          '?autoplay=1&rel=0&modestbranding=1&playsinline=1" title="Trailer" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe>';
        trailerEl.classList.add('playing');
        return;
      }
      // "More like this" opens that title's detail.
      var simEl = e.target.closest('.detail-similar-card');
      if (simEl && simEl.dataset.similarRef) {
        var modalBody = document.querySelector('#gameModal .modal-content');
        if (modalBody) modalBody.scrollTop = 0;
        showDetails(simEl.dataset.similarRef);
        return;
      }
    });

    loadGenres();
    loadUserCustomLists();
    fetchMedia(true);

    // Deep link from the dashboard / a shared card: ?open=<ref> opens a detail.
    var openRef = new URLSearchParams(location.search).get('open');
    if (openRef && /^[a-z]+_[a-z_]*\d+$/i.test(openRef)) {
      setTimeout(function () { showDetails(openRef); }, 250);
    }
  }

  function onClick(id, fn) { var el = byId(id); if (el) el.addEventListener('click', fn); }

  async function loadUserCustomLists() {
    if (guest()) { userCustomLists = []; return; }
    try {
      var r = await apiFetch('/user/lists');
      if (r.ok) { var d = await r.json(); userCustomLists = d.lists || []; }
    } catch (_) {}
  }

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

      var r = await apiFetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          search: currentFilters.search || undefined,
          genre: currentFilters.genre || undefined,
          sort: sortKey,
          sortOrder: currentSortOrder,
          comingSoon: isComing,
          limit: perPage,
          offset: offset
        })
      });

      var data = await r.json();
      if (r.ok && Array.isArray(data)) {
        data.forEach(function (m) { if (m && m.id) lastResults[m.id] = m; });
        hasMore = data.length === perPage;
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
      return '<div class="game-card" data-game-id="' + esc(m.id) + '" role="button" tabindex="0" aria-label="' + esc(label) + '">' +
        '<div class="game-image-wrapper">' +
          '<img src="' + esc(imgSrc) + '" alt="' + esc((m.name || NOUN) + ' cover') + '" class="game-image" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
          ratingHtml +
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

  async function showDetails(ref) {
    var media = lastResults[ref];
    try {
      var parsed = ref.match(/_(\d+)$/);
      if (parsed) {
        var r = await apiFetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(parsed[1]) })
        });
        var arr = await r.json();
        if (r.ok && Array.isArray(arr) && arr.length) { media = arr[0]; lastResults[ref] = media; }
      }
    } catch (_) {}
    if (!media) { if (typeof toast === 'function') toast('Could not load details.', 'error'); return; }

    var heroBg = media.backdrop_image || media.background_image || '/img/no-image.svg';
    var coverSrc = media.background_image || heroBg;

    var creditLabel = MEDIA_TYPE === 'series' ? 'Creator' : 'Director';
    var studioLabel = MEDIA_TYPE === 'series' ? 'Network' : 'Studio';
    // Release date is shown as a badge under the title, so it is intentionally
    // omitted from the info grid below to avoid printing it twice.
    var infoItems = [
      (media.developers && media.developers.length) ? { label: creditLabel, value: media.developers.map(function (d) { return d.name || d; }).join(', ') } : null,
      (media.publishers && media.publishers.length) ? { label: studioLabel, value: media.publishers.map(function (p) { return p.name || p; }).join(', ') } : null,
      (MEDIA_TYPE === 'series' && media.number_of_seasons) ? { label: 'Seasons', value: String(media.number_of_seasons) } : null,
      ((MEDIA_TYPE === 'series' || MEDIA_TYPE === 'anime') && media.number_of_episodes) ? { label: 'Episodes', value: String(media.number_of_episodes) } : null,
      (MEDIA_TYPE === 'anime' && media.subtype) ? { label: 'Type', value: String(media.subtype) } : null,
      (MEDIA_TYPE === 'anime' && media.episode_length) ? { label: 'Episode length', value: media.episode_length + ' min' } : null,
      (MEDIA_TYPE === 'anime' && media.status) ? { label: 'Status', value: ANIME_STATUS_LABEL[media.status] || media.status } : null,
      (MEDIA_TYPE === 'anime' && media.age_rating) ? { label: 'Rating', value: String(media.age_rating) } : null,
      (MEDIA_TYPE === 'movie' && media.runtime) ? { label: 'Runtime', value: media.runtime + ' min' } : null
    ].filter(Boolean);

    var customListOptions = userCustomLists.map(function (list) {
      return '<option value="custom_' + esc(list.id) + '">' + esc(list.name) + '</option>';
    }).join('');

    var genreTagsHtml = (media.genres && media.genres.length)
      ? '<div class="game-detail-genres">' + media.genres.map(function (g) { return '<span class="game-detail-genre-tag">' + esc(g.name || g) + '</span>'; }).join('') + '</div>'
      : '';

    var infoGridHtml = infoItems.length
      ? '<div class="game-detail-info-grid">' + infoItems.map(function (it) {
          return '<div class="game-detail-info-item"><div class="game-detail-info-label">' + esc(it.label) + '</div><div class="game-detail-info-value">' + esc(it.value) + '</div></div>';
        }).join('') + '</div>'
      : '';

    var releasedBadge = media.released
      ? '<span class="game-detail-date">' + esc(new Date(media.released).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })) + '</span>'
      : '';
    var ratingBadge = media.rating
      ? '<span class="detail-rating" title="Average rating">★ ' + esc(Number(media.rating).toFixed(1)) + '<span class="dr-sub">/5</span></span>'
      : '';

    // ── Detail extras (cast, trailer, where-to-watch, similar) ──────────────
    function provRow(label, arr) {
      if (!arr || !arr.length) return '';
      return '<div class="detail-prov-row"><span class="detail-prov-label">' + label + '</span>' +
        '<div class="detail-prov-logos">' + arr.map(function (p) {
          return '<img src="' + esc(p.logo || '/img/no-image.svg') + '" alt="' + esc(p.name) + '" title="' + esc(p.name) + '" loading="lazy">';
        }).join('') + '</div></div>';
    }
    var watchHtml = media.providers
      ? '<div class="detail-section"><h3 class="detail-h">Where to watch</h3>' +
          '<div class="detail-providers">' +
            provRow('Stream', media.providers.flatrate) + provRow('Rent', media.providers.rent) + provRow('Buy', media.providers.buy) +
          '</div>' +
          (media.providers.link ? '<a class="link-btn" href="' + esc(media.providers.link) + '" target="_blank" rel="noopener noreferrer">More options ↗</a>' : '') +
        '</div>'
      : '';
    var trailerHtml = (media.trailer && media.trailer.key)
      ? '<div class="detail-section"><h3 class="detail-h">Trailer</h3>' +
          '<div class="detail-trailer" data-yt="' + esc(media.trailer.key) + '">' +
            '<img src="https://i.ytimg.com/vi/' + esc(media.trailer.key) + '/hqdefault.jpg" alt="Play trailer" loading="lazy" onerror="this.src=\'https://i.ytimg.com/vi/' + esc(media.trailer.key) + '/hqdefault.jpg\'">' +
            '<span class="detail-trailer-play" aria-hidden="true"></span>' +
          '</div>' +
          '<a class="detail-trailer-fallback" href="https://www.youtube.com/watch?v=' + esc(media.trailer.key) + '" target="_blank" rel="noopener noreferrer">Trouble playing? Watch on YouTube ↗</a>' +
        '</div>'
      : '';
    var castHtml = (media.cast && media.cast.length)
      ? '<div class="detail-section"><h3 class="detail-h">Cast</h3><div class="detail-cast">' +
          media.cast.map(function (c) {
            return '<div class="detail-cast-card">' +
              '<img src="' + esc(c.image || '/img/no-image.svg') + '" alt="' + esc(c.name) + '" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
              '<div class="dc-name">' + esc(c.name) + '</div>' +
              (c.character ? '<div class="dc-char">' + esc(c.character) + '</div>' : '') +
            '</div>';
          }).join('') +
        '</div></div>'
      : '';
    var similarHtml = (media.similar && media.similar.length)
      ? '<div class="detail-section"><h3 class="detail-h">More like this</h3><div class="detail-similar">' +
          media.similar.map(function (s) {
            return '<button type="button" class="detail-similar-card" data-similar-ref="' + esc(s.id) + '" title="' + esc(s.name) + '">' +
              '<img src="' + esc(s.background_image) + '" alt="' + esc(s.name) + '" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
              '<span class="ds-name">' + esc(s.name) + '</span>' +
            '</button>';
          }).join('') +
        '</div></div>'
      : '';

    var descHtml = '';
    if (media.description) {
      var d = String(media.description);
      if (d.length > 420) {
        descHtml = '<div class="game-detail-desc">' +
          '<p class="desc-short">' + esc(d.slice(0, 420)) + '…</p>' +
          '<p class="desc-full hidden">' + esc(d) + '</p>' +
          '<button type="button" class="link-btn show-more-btn">Show more</button></div>';
      } else {
        descHtml = '<p class="game-detail-desc">' + esc(d) + '</p>';
      }
    }

    var defaultLabel = MEDIA_TYPE === 'series' ? 'My Shows Library (Default)'
      : MEDIA_TYPE === 'anime' ? 'My Anime Library (Default)'
      : 'My Movie Library (Default)';

    byId('gameDetails').innerHTML =
      '<div class="game-detail-hero">' +
        '<img src="' + esc(heroBg) + '" alt="' + esc(media.name) + ' banner" class="game-detail-hero-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
      '</div>' +
      '<div class="game-detail-body">' +
        '<div class="game-detail-title-row">' +
          '<img src="' + esc(coverSrc) + '" alt="' + esc(media.name) + ' cover" class="game-detail-cover" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
          '<div class="game-detail-title-meta">' +
            '<div class="game-detail-title">' + esc(media.name) + '</div>' +
            '<div class="game-detail-badges">' + releasedBadge + ratingBadge + '</div>' +
          '</div>' +
        '</div>' +
        genreTagsHtml + infoGridHtml + descHtml + trailerHtml + watchHtml + castHtml +
        '<div class="add-to-list">' +
          '<h3>Add to My Library</h3>' +
          '<div style="margin-bottom:12px;">' +
            '<label>Add to list</label>' +
            '<select id="gameListSelect" class="filter-select" style="width:100%;margin:0;">' +
              '<option value="default">' + esc(defaultLabel) + '</option>' + customListOptions +
            '</select>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">' +
            '<div>' +
              '<label>Status</label>' +
              '<select id="gameStatus" class="filter-select" style="width:100%;margin:0;">' + statusOptions(MEDIA_TYPE, 'completed') + '</select>' +
            '</div>' +
            '<div>' +
              '<label>Your score (1-10)</label>' +
              '<div class="score-input-container" style="margin:0;">' +
                '<input type="number" id="gameScore" class="score-input" min="1" max="10" placeholder="--" style="width:100%;">' +
                '<div class="score-controls">' +
                  '<button type="button" class="score-btn" id="mbScoreUp" aria-label="Increase score">+</button>' +
                  '<button type="button" class="score-btn" id="mbScoreDown" aria-label="Decrease score">−</button>' +
                '</div>' +
                '<button type="button" class="btn btn-sm score-clear-btn" id="mbScoreClear">No Score</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:12px;">' +
            '<button class="btn btn-primary btn-sm add-to-list-btn" data-game-id="' + esc(media.id) + '" style="flex-shrink:0;white-space:nowrap;">Add to Library</button>' +
            '<span id="addGameMessage" style="font-size:13px;font-weight:600;"></span>' +
          '</div>' +
        '</div>' +
        similarHtml +
      '</div>';

    if (typeof bindScoreInput === 'function') bindScoreInput('gameScore', 'mbScoreUp', 'mbScoreDown', 'mbScoreClear');
    if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(byId('gameDetails'));
    if (typeof openModal === 'function') openModal('gameModal');
  }

  function mediaToGameData(media) {
    return {
      media_type: media.media_type,
      provider: media.provider,
      provider_id: media.provider_id,
      tmdb_id: media.tmdb_id,
      name: media.name,
      background_image: media.background_image,
      description: media.description,
      rating: media.rating,
      metacritic_score: media.metacritic_score,
      released: media.released,
      number_of_episodes: media.number_of_episodes,
      genres: media.genres || [],
      developers: media.developers || [],
      publishers: media.publishers || []
    };
  }

  async function addToLibrary(ref) {
    if (guest()) { promptSignIn('Create a free account to build your library.'); return; }
    var media = lastResults[ref];
    if (!media) { if (typeof toast === 'function') toast('Please reopen this title and try again.', 'error'); return; }

    var statusSelect = byId('gameStatus');
    var scoreInput = byId('gameScore');
    var listSelect = byId('gameListSelect');
    var messageEl = byId('addGameMessage');
    var listValue = listSelect ? listSelect.value : 'default';
    var status = statusSelect ? statusSelect.value : 'plan_to_play';
    var score = scoreInput ? scoreInput.value : '';

    if (score && (parseInt(score) < 1 || parseInt(score) > 10)) {
      showMsg(messageEl, 'Score must be between 1 and 10.', 'error');
      return;
    }

    var gameData = mediaToGameData(media);
    var scoreVal = score ? parseInt(score) : null;

    try {
      if (listValue === 'default') {
        var addResp = await apiFetch('/user/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game_id: media.id, game_data: gameData, status: status, score: scoreVal })
        });
        var addData = await addResp.json();
        if (!addResp.ok) {
          var already = addData.error === 'Game already in your list';
          showMsg(messageEl, already ? 'Already in your library.' : (addData.error || 'Failed to add.'), already ? 'success' : 'error');
          return;
        }
        showMsg(messageEl, 'Added to your library.', 'success');
        return;
      }

      // Custom list: the list-add endpoint accepts game_data and upserts the catalog
      // row itself, so no separate default-collection write is needed.
      var listId = listValue.replace('custom_', '');
      var listResp = await apiFetch('/user/lists/' + listId + '/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_data: gameData, status: status, score: scoreVal })
      });
      var listData = await listResp.json();
      if (!listResp.ok) {
        var dup = listData.error === 'Game already in this list';
        showMsg(messageEl, dup ? 'Already in that list.' : ('Failed: ' + (listData.error || 'error')), dup ? 'success' : 'error');
        return;
      }
      var matched = userCustomLists.find(function (l) { return String(l.id) === String(listId); });
      showMsg(messageEl, 'Added to "' + (matched ? matched.name : 'list') + '".', 'success');
      loadUserCustomLists();
    } catch (err) {
      showMsg(messageEl, 'Network error. Please try again.', 'error');
    }
  }

  function showMsg(el, text, type) {
    if (!el) return;
    el.textContent = text;
    el.style.color = type === 'error' ? 'var(--red-light)' : 'var(--green-light)';
  }

  function doSearch() {
    var term = byId('searchInput').value.trim();
    currentFilters.search = term;
    var sortBy = byId('sortBy');
    if (term) { if (sortBy) sortBy.value = 'popularity-desc'; currentSort = 'popularity'; currentSortOrder = 'desc'; }
    currentPage = 1; hasMore = true; window.scrollTo(0, 0); fetchMedia(true);
  }

  function applyFilters() {
    currentFilters = { genre: byId('genre').value, search: currentFilters.search || '' };
    currentPage = 1; hasMore = true; window.scrollTo(0, 0); fetchMedia(true);
  }

  function resetFilters() {
    var g = byId('genre'); if (g) g.value = '';
    var s = byId('searchInput'); if (s) s.value = '';
    currentFilters = {};
    currentPage = 1; hasMore = true; window.scrollTo(0, 0); fetchMedia(true);
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
