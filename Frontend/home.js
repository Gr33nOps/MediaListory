const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '/api';

function readStoredUser() {
    try {
        var raw = localStorage.getItem('currentUser');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

let authToken   = localStorage.getItem('authToken');
let currentUser = readStoredUser();
let allGames    = [];
let currentFilters   = {};
let currentSort      = 'popularity';
let currentSortOrder = 'desc';
let currentPage    = 1;
let gamesPerPage   = 24;
let apiGamesPerPage = 24;
let isLoading    = false;
let hasMoreGames = true;
let retryCount   = 0;
const maxRetries = 3;
let isVerifying  = false;

let userCustomLists = [];

// Filter dropdown options come from enumerable IGDB resources only (genres,
// platforms, game modes). Publisher/developer were dropped from the UI because
// their option lists were built from the currently-loaded page - an incomplete,
// misleading set - and IGDB has no lightweight companies list to back them.
let allFilterOptions = {
    genres:     new Set(),
    platforms:  new Set(),
    gameModes:  new Set()
};

function logout() {
    if (typeof logoutToAuth === 'function') logoutToAuth();
    else {
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        window.location.href = 'auth.html';
    }
}
window.logout = logout;

const EDITION_KEYWORDS = [
    'game of the year', 'goty', 'definitive edition', 'enhanced edition',
    'complete edition', 'deluxe edition', 'gold edition', 'platinum edition',
    'ultimate edition', 'premium edition', "collector's edition", 'collectors edition',
    'remastered', "director's cut", 'directors cut', 'special edition',
    'extended edition', 'anniversary edition', 'legacy edition', 'royal edition',
    'master chief collection', '- bundle', ': bundle', 'bundle edition',
    'expanded edition', 'full edition', 'digital deluxe', 'digital premium'
];

function isEditionVariant(name) {
    if (!name) return false;
    var lower = name.toLowerCase();
    return EDITION_KEYWORDS.some(function(kw) { return lower.includes(kw); });
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

function authHeaders(extra) {
    var headers = {};
    if (authToken) headers.Authorization = 'Bearer ' + authToken;
    if (extra) {
        Object.keys(extra).forEach(function(key) { headers[key] = extra[key]; });
    }
    return headers;
}

function isGuest() { return !authToken; }

function promptSignIn(message) {
    if (typeof toast === 'function') toast(message || 'Create a free account to save this.', 'info');
    setTimeout(function () {
        window.location.href = (typeof authUrlWithNext === 'function' ? authUrlWithNext() : 'auth.html');
    }, 900);
}

(async function bootHome() {
    if (typeof ensureSession === 'function') {
        try { await ensureSession(); } catch (_) {}
    }
    authToken = localStorage.getItem('authToken');
    currentUser = readStoredUser();
    if (!authToken) {
        // Guest mode: browse without an account. Saving prompts sign-in.
        initPage();
        return;
    }
    verifyToken();
})();

async function verifyToken() {
    if (isVerifying) return;
    isVerifying = true;

    try {
        const response = await fetch(API_BASE + '/auth/me', {
            cache: 'no-store',
            headers: {
                'Authorization': 'Bearer ' + authToken,
                'Content-Type': 'application/json'
            }
        });

        // 304 is not response.ok - browsers cache GETs and break session bootstrap.
        if (response.ok || response.status === 304) {
            var user = currentUser;
            if (response.status !== 304) {
                var data = await response.json();
                user = data.user;
                currentUser = user;
                localStorage.setItem('currentUser', JSON.stringify(user));
            }
            if (!user) {
                isVerifying = false;
                logout();
                return;
            }

            isVerifying = false;
            initPage();
        } else {
            isVerifying = false;
            if (response.status === 401 || response.status === 403) {
                logout();
            } else {
                showConnectionError('Server returned ' + response.status + ' while loading your session.');
            }
        }
    } catch (error) {
        console.error('Error during home init / token verification:', error);
        isVerifying = false;
        showConnectionError(
            (error && error.message)
                ? ('Page failed to start: ' + error.message)
                : 'Unable to connect to the server. Please make sure the backend is running.'
        );
    }
}

function showConnectionError(detail) {
    var container = document.querySelector('.container');
    if (!container) return;
    container.innerHTML =
        '<div style="display:flex;justify-content:center;align-items:center;min-height:100vh;flex-direction:column;gap:20px;padding:20px;">' +
            '<h2 style="color:#ff6b6b;">Connection Error</h2>' +
            '<p style="color:#fff;text-align:center;">' +
                esc(detail || 'Unable to connect to the server. Please make sure the backend is running.') +
            '</p>' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
                '<button type="button" id="connRetryBtn" class="btn btn-primary">Retry</button>' +
                '<button type="button" id="connLogoutBtn" class="btn btn-danger">Logout</button>' +
            '</div>' +
        '</div>';
    var retryBtn = document.getElementById('connRetryBtn');
    var logoutBtnEl = document.getElementById('connLogoutBtn');
    if (retryBtn) retryBtn.addEventListener('click', function() { location.reload(); });
    if (logoutBtnEl) logoutBtnEl.addEventListener('click', logout);
}

function onClick(id, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
}

function initPage() {
    // Nav logout is owned by common.js mountAppNav (#navLogoutBtn).
    onClick('logoutBtn', logout);
    onClick('searchBtn', searchGames);
    onClick('filterBtn', toggleFilterSection);
    onClick('applyFiltersBtn', applyFilters);
    onClick('resetFiltersBtn', resetFilters);
    if (typeof bindModal === 'function') {
        bindModal('gameModal', 'closeModalBtn');
    } else {
        onClick('closeModalBtn', function() {
            document.getElementById('gameModal').style.display = 'none';
        });
    }

    var searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') searchGames();
        });
        // Live search: results update as you type (debounced), like the global bar.
        var searchDebounce;
        searchInput.addEventListener('input', function() {
            clearTimeout(searchDebounce);
            var term = searchInput.value.trim();
            searchDebounce = setTimeout(function() {
                if (term.length === 0 || term.length >= 2) searchGames();
            }, 350);
        });
    }

    var sortBySelect = document.getElementById('sortBy');
    if (sortBySelect) {
        sortBySelect.value = 'popularity-desc';
        sortBySelect.addEventListener('change', function() {
            var value = sortBySelect.value;

            if (value === 'coming-soon') {
                currentSort      = 'coming';
                currentSortOrder = 'soon';
            } else {
                var dashIdx      = value.lastIndexOf('-');
                currentSort      = value.substring(0, dashIdx);
                currentSortOrder = value.substring(dashIdx + 1);
            }

            currentPage  = 1;
            allGames     = [];
            hasMoreGames = true;
            retryCount   = 0;
            window.scrollTo(0, 0);
            fetchGames(true);
        });
    }

    onClick('prevPageBtn', goToPreviousPage);
    onClick('nextPageBtn', goToNextPage);

    if (typeof bindActivatableCards === 'function') {
        bindActivatableCards(document, '.game-card', function(card) {
            showGameDetails(card.dataset.gameId);
        });
    } else {
        document.addEventListener('click', function(e) {
            var gameCard = e.target.closest('.game-card');
            if (gameCard && !e.target.classList.contains('btn')) {
                showGameDetails(gameCard.dataset.gameId);
            }
        });
    }

    document.addEventListener('click', function(e) {
        // Play the game trailer inline (swap facade for a lazy YouTube embed).
        var trailerEl = e.target.closest('.detail-trailer');
        if (trailerEl && trailerEl.dataset.yt && !trailerEl.classList.contains('playing')) {
            var key = trailerEl.dataset.yt;
            trailerEl.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(key) +
                '?autoplay=1&rel=0&modestbranding=1&playsinline=1" title="Trailer" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe>';
            trailerEl.classList.add('playing');
            return;
        }
        // "More like this" opens that game's detail.
        var serEl = e.target.closest('.detail-series-item');
        if (serEl && serEl.dataset.seriesRef) {
            e.preventDefault();
            e.stopPropagation();
            showGameDetails(serEl.dataset.seriesRef);
            return;
        }

        var simEl = e.target.closest('.detail-similar-card');
        if (simEl && simEl.dataset.similarRef) {
            var modalBody = document.querySelector('#gameModal .modal-content');
            if (modalBody) modalBody.scrollTop = 0;
            showGameDetails(simEl.dataset.similarRef);
            return;
        }
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
            var gameId   = e.target.dataset.gameId;
            var gameData = e.target.dataset.gameData;
            addToList(gameId, gameData ? JSON.parse(gameData) : null);
        }
    });

    var pendingGenre = '';
    try {
        pendingGenre = new URLSearchParams(window.location.search).get('genre') || '';
        if (!pendingGenre) pendingGenre = sessionStorage.getItem('mglBrowseGenre') || '';
        sessionStorage.removeItem('mglBrowseGenre');
    } catch (_) {}
    if (pendingGenre) {
        currentFilters.genre = pendingGenre;
        var filterSection = document.getElementById('filterSection');
        if (filterSection) filterSection.classList.remove('hidden');
    }

    loadIGDBFilters().then(function () {
        if (pendingGenre) {
            var genreSelect = document.getElementById('genre');
            if (genreSelect) {
                var exists = Array.prototype.some.call(genreSelect.options, function (o) {
                    return o.value === pendingGenre;
                });
                if (!exists) {
                    // nosemgrep: javascript.browser.security.raw-html-concat.raw-html-concat, javascript.browser.xss.xss -- pendingGenre is HTML-escaped via esc() before interpolation
                    genreSelect.innerHTML += '<option value="' + esc(pendingGenre) + '">' + esc(pendingGenre) + '</option>';
                }
                genreSelect.value = pendingGenre;
            }
        }
    });
    loadUserCustomLists();
    fetchGames(true);

    // Deep link from the dashboard: ?open=igdb_<id> opens that game's detail.
    var openRef = new URLSearchParams(window.location.search).get('open');
    if (openRef && /^igdb_\d+$/i.test(openRef)) {
        setTimeout(function () { showGameDetails(openRef); }, 250);
    }
}

async function loadUserCustomLists() {
    if (isGuest()) { userCustomLists = []; return; }
    try {
        var r = await fetch(`${API_BASE}/user/lists`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) {
            var d = await r.json();
            userCustomLists = d.lists || [];
        }
    } catch (e) {
        console.error('Failed to load custom lists:', e);
    }
}

async function loadIGDBFilters() {
    try {
        var genresResponse = await fetch(`${API_BASE}/igdb/genres`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: '{}'
        });
        if (genresResponse.ok) {
            var genres = await genresResponse.json();
            genres.forEach(function(genre) { allFilterOptions.genres.add(genre.name); });
        }

        var platformsResponse = await fetch(`${API_BASE}/igdb/platforms`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: '{}'
        });
        if (platformsResponse.ok) {
            var platforms = await platformsResponse.json();
            platforms.forEach(function(platform) { allFilterOptions.platforms.add(platform.name); });
        }

        var modesResponse = await fetch(`${API_BASE}/igdb/game_modes`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: '{}'
        });
        if (modesResponse.ok) {
            var modes = await modesResponse.json();
            modes.forEach(function(mode) { if (mode && mode.name) allFilterOptions.gameModes.add(mode.name); });
        }

        populateYearOptions();
        populateFilterOptions();
    } catch (error) {
        console.error('Error loading filters:', error);
    }
}

function populateYearOptions() {
    var yearSelect = document.getElementById('year');
    if (!yearSelect || yearSelect.options.length > 1) return;
    var now = new Date().getFullYear();
    var opts = '<option value="">Any year</option>';
    for (var y = now; y >= 1958; y--) {
        opts += '<option value="' + y + '">' + y + '</option>';
    }
    yearSelect.innerHTML = opts;
}

function skeletonCards(n) {
    var one = '<div class="skeleton-card"><div class="skeleton skel-poster"></div>' +
        '<div class="skel-info"><div class="skeleton skel-line w80"></div><div class="skeleton skel-line w50"></div></div></div>';
    return new Array(n).join(one) + one;
}

async function fetchGames(replace) {
    if (replace === undefined) replace = true;
    if (isLoading || (!replace && !hasMoreGames)) return;
    isLoading = true;

    if (replace) {
        document.getElementById('loadingIndicator').style.display = 'none';
        document.getElementById('searchResults').innerHTML = skeletonCards(12);
    } else {
        document.getElementById('loadingIndicator').style.display = 'flex';
    }

    try {
        var offset           = (currentPage - 1) * apiGamesPerPage;
        var currentTimestamp = Math.floor(Date.now() / 1000);
        var isSearchMode     = !!(currentFilters.search && currentFilters.search.trim());
        var isComingSoon     = currentSort === 'coming' && currentSortOrder === 'soon';
        var isPopularity     = currentSort === 'popularity';

        var sortKey = isComingSoon ? 'coming' : (isPopularity ? 'popularity' : currentSort);

        var response = await fetch(`${API_BASE}/igdb/games`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                search: currentFilters.search || undefined,
                genre: currentFilters.genre || undefined,
                platform: currentFilters.platform || undefined,
                gameMode: currentFilters.gameMode || undefined,
                year: currentFilters.year || undefined,
                minRating: currentFilters.minRating || undefined,
                sort: sortKey,
                sortOrder: currentSortOrder,
                comingSoon: isComingSoon,
                limit: apiGamesPerPage,
                offset: offset
            })
        });

        var data = await response.json();

        if (response.ok) {
            retryCount = 0;

            var filteredData = data;
            if (!isComingSoon) {
                filteredData = data.filter(function(game) {
                    return game.first_release_date && game.first_release_date <= currentTimestamp;
                });
            } else {
                filteredData = data.filter(function(game) {
                    return game.first_release_date && game.first_release_date > currentTimestamp;
                });
            }

            var searchTermIsEdition = isSearchMode &&
                EDITION_KEYWORDS.some(function(kw) { return currentFilters.search.toLowerCase().includes(kw); });

            if (!searchTermIsEdition) {
                filteredData = filteredData.filter(function(game) { return !isEditionVariant(game.name); });
            }

            var transformedGames = filteredData.map(function(game) {
                var publishers = [];
                var developers = [];
                if (game.involved_companies) {
                    game.involved_companies.forEach(function(ic) {
                        if (ic.company) {
                            if (ic.publisher) publishers.push({ name: ic.company.name });
                            if (ic.developer) developers.push({ name: ic.company.name });
                        }
                    });
                }

                var displayRating = null;
                var igdbScore     = null;
                if (game.total_rating && game.total_rating_count >= 5) {
                    displayRating = (game.total_rating / 20).toFixed(1);
                    igdbScore     = Math.round(game.total_rating);
                } else if (game.aggregated_rating && game.aggregated_rating_count >= 3) {
                    displayRating = (game.aggregated_rating / 20).toFixed(1);
                    igdbScore     = Math.round(game.aggregated_rating);
                }

                return {
                    id:               'igdb_' + game.id,
                    igdb_id:          game.id,
                    name:             game.name,
                    background_image: game.cover
                        ? 'https:' + game.cover.url.replace('t_thumb', 't_cover_big')
                        : null,
                    rating:           displayRating,
                    description:      game.summary || '',
                    released:         game.first_release_date
                        ? new Date(game.first_release_date * 1000).toISOString().split('T')[0]
                        : null,
                    metacritic_score: igdbScore,
                    rating_count:     game.total_rating_count || game.rating_count || 0,
                    playtime:         0,
                    genres:           game.genres    || [],
                    platforms:        game.platforms || [],
                    publishers:       publishers,
                    developers:       developers,
                    is_coming_soon:   game.first_release_date
                        ? game.first_release_date > currentTimestamp
                        : false
                };
            });

            allGames     = replace ? transformedGames : allGames.concat(transformedGames);
            hasMoreGames = data.length === apiGamesPerPage;

            if (typeof applyQueryStateNotice === 'function') applyQueryStateNotice(queryStateFrom(response));

            collectFilterOptions(transformedGames);
            // Before rendering, so the first paint already carries the badges.
            if (typeof loadLibraryIndex === 'function') await loadLibraryIndex();
            displaySearchResults(transformedGames, replace);
            updatePaginationButtons();

            if (transformedGames.length === 0 && replace) {
                var message = currentFilters.search
                    ? 'No games found for "' + currentFilters.search + '".'
                    : isComingSoon ? 'No upcoming games found.' : 'No games found.';
                document.getElementById('searchResults').innerHTML =
                    '<div class="empty-state">' + esc(message) + '</div>';
            }
        } else if (response.status === 429 && retryCount < maxRetries) {
            retryCount++;
            await new Promise(function(resolve) { setTimeout(resolve, 2000 * retryCount); });
            return fetchGames(replace);
        } else {
            var errBody = {};
            try { errBody = await response.json(); } catch (_) {}
            var msg = 'Could not load games from IGDB.';
            if (response.status === 401) msg = 'Session expired - sign in again to browse games.';
            else if (response.status === 503) msg = 'Database unavailable. Game browse needs a healthy /ready check.';
            else if (response.status === 429) msg = 'IGDB rate limit hit. Wait a moment, then retry.';
            else if (typeof describeApiError === 'function') msg = describeApiError(response, errBody, msg);
            document.getElementById('searchResults').innerHTML =
                '<div class="empty-state">' + esc(msg) + '</div>';
            if (typeof toast === 'function') toast(msg, 'error');
        }
    } catch (error) {
        console.error('Fetch error:', error);
        if (retryCount < maxRetries) {
            retryCount++;
            await new Promise(function(resolve) { setTimeout(resolve, 2000 * retryCount); });
            return fetchGames(replace);
        }
        var netMsg = 'Network error talking to the server (not IGDB). Check your connection.';
        document.getElementById('searchResults').innerHTML =
            '<div class="empty-state">' + esc(netMsg) + '</div>';
        if (typeof toast === 'function') toast(netMsg, 'error');
    } finally {
        isLoading = false;
        document.getElementById('loadingIndicator').style.display = 'none';
    }
}

function collectFilterOptions(games) {
    games.forEach(function(game) {
        if (game.genres)    game.genres.forEach(function(g) { allFilterOptions.genres.add(g.name); });
        if (game.platforms) game.platforms.forEach(function(p) { allFilterOptions.platforms.add(p.name); });
    });
    populateFilterOptions();
}

function getRatingColor(score) {
    if (!score)    return '#666';
    if (score >= 90) return '#10b981';
    if (score >= 75) return '#3b82f6';
    if (score >= 50) return '#f59e0b';
    return '#ef4444';
}


/* ── The run a title belongs to ──────────────────────────────────────────────
   Deliberately not styled as another "More like this" strip. That one is a
   guess at taste; this is a position in a sequence, so it reads left to right
   in order, each entry says where it sits, and the title you are already
   looking at is marked and not clickable. Without that anchor a row of posters
   is just more thumbnails. */

var RELATION_WORD = {
    prequel: 'Prequel',
    sequel: 'Sequel',
    earlier: 'Earlier',
    later: 'Later',
    current: 'You are here'
};

function seriesSectionHtml(relations) {
    if (!Array.isArray(relations) || !relations.length) return '';
    var hasOther = relations.some(function (r) { return r.relation !== 'current'; });
    if (!hasOther) return '';

    var items = relations.map(function (r) {
        var here = r.relation === 'current';
        var year = r.released ? String(r.released).slice(0, 4) : '';
        var word = RELATION_WORD[r.relation] || '';
        var img = '<img src="' + esc(r.image || '/img/no-image.svg') + '" alt="" loading="lazy"' +
            ' onerror="this.src=\'/img/no-image.svg\'">';
        var caption =
            '<span class="dsr-rel">' + esc(word) + (year && !here ? ' \u00B7 ' + esc(year) : '') + '</span>' +
            '<span class="ds-name">' + esc(r.name) + '</span>';

        // The current entry is a label, not a control: clicking it would reload
        // the page you are already on.
        if (here) {
            return '<div class="detail-series-item is-here" aria-current="true">' + img + caption + '</div>';
        }
        return '<button type="button" class="detail-series-item" data-series-ref="' + esc(r.id) + '"' +
            ' title="' + esc(r.name) + '">' + img + caption + '</button>';
    }).join('');

    return '<div class="detail-section"><h3 class="detail-h">In this series</h3>' +
        '<div class="detail-series">' + items + '</div></div>';
}

function displaySearchResults(games, replace) {
    if (replace === undefined) replace = true;
    var container = document.getElementById('searchResults');

    if (games.length === 0 && replace) {
        container.innerHTML = '<div class="empty-state">No games found.</div>';
        return;
    }

    var currentTimestamp = Math.floor(Date.now() / 1000);

    var html = games.map(function(game) {
        var gameReleaseTs = game.released ? new Date(game.released).getTime() / 1000 : 0;
        var isComingSoon  = gameReleaseTs > currentTimestamp;
        var imgSrc        = game.background_image || '/img/no-image.svg';

        var releasedHtml = '';
        if (game.released) {
            var dateStr = new Date(game.released).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
            releasedHtml = '<span class="game-card-date' + (isComingSoon ? ' is-soon' : '') + '">' + esc(dateStr) + '</span>';
        }

        // Poster-first tile: cover + title + year. Genres, platforms and the
        // summary all live in the detail modal.
        var cardLabel = 'View details for ' + (game.name || 'game');
        var ratingHtml = game.rating ? '<span class="card-rating">★ ' + esc(Number(game.rating).toFixed(1)) + '</span>' : '';
        // Says "you already have this" before the user adds it a second time.
        var ownedHtml = typeof ownedBadgeHtml === 'function' ? ownedBadgeHtml(game.id) : '';
        return '<div class="game-card" data-game-id="' + esc(game.id) + '" role="button" tabindex="0" aria-label="' + esc(cardLabel) + '">' +
            '<div class="game-image-wrapper">' +
                '<img src="' + esc(imgSrc) + '" alt="' + esc(game.name || 'Game') + ' cover" class="game-image" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                ratingHtml + ownedHtml +
            '</div>' +
            '<div class="game-info">' +
                '<div class="game-title">' + esc(game.name) + '</div>' +
                '<div class="game-card-meta">' + releasedHtml + '</div>' +
            '</div>' +
        '</div>';
    }).join('');

    if (replace) {
        container.innerHTML = html;
    } else {
        // nosemgrep: typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method -- html is assembled only from esc()-escaped values above
        container.insertAdjacentHTML('beforeend', html);
    }
}

async function showGameDetails(gameId) {
    try {
        var game;

        if (gameId.startsWith('igdb_')) {
            var igdbId = gameId.replace('igdb_', '');

            var response = await fetch(`${API_BASE}/igdb/games`, {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ id: Number(igdbId) })
            });

            var igdbGames = await response.json();

            if (response.ok && igdbGames.length > 0) {
                var igdbGame   = igdbGames[0];
                var publishers = [];
                var developers = [];

                if (igdbGame.involved_companies) {
                    igdbGame.involved_companies.forEach(function(ic) {
                        if (ic.company) {
                            if (ic.publisher) publishers.push({ name: ic.company.name });
                            if (ic.developer) developers.push({ name: ic.company.name });
                        }
                    });
                }

                var displayRating = null;
                var igdbScore     = null;
                if (igdbGame.total_rating && igdbGame.total_rating_count >= 5) {
                    displayRating = (igdbGame.total_rating / 20).toFixed(1);
                    igdbScore     = Math.round(igdbGame.total_rating);
                } else if (igdbGame.aggregated_rating && igdbGame.aggregated_rating_count >= 3) {
                    displayRating = (igdbGame.aggregated_rating / 20).toFixed(1);
                    igdbScore     = Math.round(igdbGame.aggregated_rating);
                }

                // Pick the first "Trailer" video, else the first video of any kind.
                var vids = igdbGame.videos || [];
                var vid = vids.find(function (v) { return /trailer/i.test(v.name || ''); }) || vids[0];

                game = {
                    id:               gameId,
                    igdb_id:          igdbGame.id,
                    name:             igdbGame.name,
                    background_image: igdbGame.cover
                        ? 'https:' + igdbGame.cover.url.replace('t_thumb', 't_cover_big')
                        : null,
                    screenshot_image: igdbGame.cover
                        ? 'https:' + igdbGame.cover.url.replace('t_thumb', 't_screenshot_big')
                        : null,
                    rating:           displayRating,
                    description:      igdbGame.summary || 'No description available',
                    released:         igdbGame.first_release_date
                        ? new Date(igdbGame.first_release_date * 1000).toISOString().split('T')[0]
                        : null,
                    metacritic_score: igdbScore,
                    rating_count:     igdbGame.total_rating_count || igdbGame.rating_count || 0,
                    playtime:         0,
                    genres:           igdbGame.genres    || [],
                    platforms:        igdbGame.platforms || [],
                    publishers:       publishers,
                    developers:       developers,
                    game_modes:       (igdbGame.game_modes || []).map(function (m) { return m.name; }).filter(Boolean),
                    perspectives:     (igdbGame.player_perspectives || []).map(function (p) { return p.name; }).filter(Boolean),
                    trailer:          vid && vid.video_id ? { key: vid.video_id } : null,
                    screenshots:      (igdbGame.screenshots || []).slice(0, 8).map(function (s) {
                        return 'https:' + s.url.replace('t_thumb', 't_screenshot_big');
                    }),
                    similar:          (igdbGame.similar_games || []).filter(function (s) { return s.cover; }).slice(0, 12).map(function (s) {
                        return {
                            id: 'igdb_' + s.id,
                            name: s.name,
                            background_image: 'https:' + s.cover.url.replace('t_thumb', 't_cover_big')
                        };
                    }),
                    // IGDB works in bare numeric ids; everything in this app
                    // addresses a game by its catalog ref, including the click
                    // that opens one of these.
                    relations:        (igdbGame.relations || []).map(function (r) {
                        return {
                            id: 'igdb_' + r.id,
                            name: r.name,
                            released: r.released,
                            image: r.image,
                            relation: r.relation
                        };
                    })
                };
            }
        } else {
            var resp = await fetch(`${API_BASE}/games/${gameId}`);
            game = await resp.json();
        }

        if (game) {
            /* Already tracked? Then this panel edits what is saved rather than
               adding a second copy. Same controls, filled in and relabelled. */
            var ownedEntry = typeof libraryEntry === 'function' ? libraryEntry(game.id) : null;

            var gameDataStr = JSON.stringify({
                igdb_id:          game.igdb_id,
                name:             game.name,
                background_image: game.background_image,
                rating:           game.rating,
                description:      game.description,
                released:         game.released,
                metacritic_score: game.metacritic_score,
                playtime:         game.playtime,
                genres:           game.genres,
                platforms:        game.platforms,
                publishers:       game.publishers,
                developers:       game.developers
            }).replace(/"/g, '&quot;');

            var heroBg   = game.screenshot_image || game.background_image || '/img/no-image.svg';
            var coverSrc = game.background_image || heroBg;

            var infoItems = [
                game.released
                    ? { label: 'Released', value: new Date(game.released).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) }
                    : null,
                game.publishers && game.publishers.length
                    ? { label: 'Publisher', value: game.publishers.map(function(p) { return p.name; }).join(', ') }
                    : null,
                game.developers && game.developers.length
                    ? { label: 'Developer', value: game.developers.map(function(d) { return d.name; }).join(', ') }
                    : null,
                game.platforms && game.platforms.length
                    ? { label: 'Platforms', value: game.platforms.map(function(p) { return p.name; }).join(' · ') }
                    : null,
                game.game_modes && game.game_modes.length
                    ? { label: 'Modes', value: game.game_modes.join(' · ') }
                    : null,
                game.perspectives && game.perspectives.length
                    ? { label: 'Perspective', value: game.perspectives.join(' · ') }
                    : null
            ].filter(Boolean);

            var customListOptions = userCustomLists.length > 0
                ? userCustomLists.map(function(list) {
                    return '<option value="custom_' + esc(list.id) + '">' + esc(list.name) + '</option>';
                }).join('')
                : '';

            var genreTagsHtml = '';
            if (game.genres && game.genres.length) {
                genreTagsHtml = '<div class="game-detail-genres">' +
                    game.genres.map(function(g) { return '<span class="game-detail-genre-tag">' + esc(g.name) + '</span>'; }).join('') +
                '</div>';
            }

            var infoGridHtml = '';
            if (infoItems.length) {
                infoGridHtml = '<div class="game-detail-info-grid">' +
                    infoItems.map(function(item) {
                        return '<div class="game-detail-info-item"><div class="game-detail-info-label">' + esc(item.label) + '</div><div class="game-detail-info-value">' + esc(item.value) + '</div></div>';
                    }).join('') +
                '</div>';
            }

            var releasedBadge = game.released
                ? '<span class="game-detail-date">' + esc(new Date(game.released).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })) + '</span>'
                : '';
            var ratingBadge = game.rating
                ? '<span class="detail-rating" title="Average rating">★ ' + esc(Number(game.rating).toFixed(1)) + '<span class="dr-sub">/5</span></span>'
                : '';

            var descHtml = '';
            if (game.description) {
                var d = String(game.description);
                if (d.length > 420) {
                    descHtml =
                        '<div class="game-detail-desc">' +
                            '<p class="desc-short">' + esc(d.slice(0, 420)) + '…</p>' +
                            '<p class="desc-full hidden">' + esc(d) + '</p>' +
                            '<button type="button" class="link-btn show-more-btn">Show more</button>' +
                        '</div>';
                } else {
                    descHtml = '<p class="game-detail-desc">' + esc(d) + '</p>';
                }
            }

            var trailerHtml = (game.trailer && game.trailer.key)
                ? '<div class="detail-section"><h3 class="detail-h">Trailer</h3>' +
                    '<div class="detail-trailer" data-yt="' + esc(game.trailer.key) + '">' +
                      '<img src="https://i.ytimg.com/vi/' + esc(game.trailer.key) + '/hqdefault.jpg" alt="Play trailer" loading="lazy">' +
                      '<span class="detail-trailer-play" aria-hidden="true"></span>' +
                    '</div>' +
                    '<a class="detail-trailer-fallback" href="https://www.youtube.com/watch?v=' + esc(game.trailer.key) + '" target="_blank" rel="noopener noreferrer">Trouble playing? Watch on YouTube ↗</a>' +
                  '</div>'
                : '';

            var shotsHtml = (game.screenshots && game.screenshots.length)
                ? '<div class="detail-section"><h3 class="detail-h">Screenshots</h3><div class="detail-shots">' +
                    game.screenshots.map(function (u) {
                        return '<a class="detail-shot" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' +
                            '<img src="' + esc(u) + '" alt="Screenshot" loading="lazy" onerror="this.closest(\'.detail-shot\').style.display=\'none\'"></a>';
                    }).join('') +
                  '</div></div>'
                : '';

            var seriesHtml = seriesSectionHtml(game.relations);

            var similarHtml = (game.similar && game.similar.length)
                ? '<div class="detail-section"><h3 class="detail-h">More like this</h3><div class="detail-similar">' +
                    game.similar.map(function (s) {
                        return '<button type="button" class="detail-similar-card" data-similar-ref="' + esc(s.id) + '" title="' + esc(s.name) + '">' +
                            '<img src="' + esc(s.background_image) + '" alt="' + esc(s.name) + '" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                            '<span class="ds-name">' + esc(s.name) + '</span>' +
                        '</button>';
                    }).join('') +
                  '</div></div>'
                : '';

            document.getElementById('gameDetails').innerHTML =
                '<div class="game-detail-hero">' +
                    '<img src="' + esc(heroBg) + '" alt="' + esc(game.name) + ' banner" class="game-detail-hero-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                '</div>' +
                '<div class="game-detail-body">' +
                    '<div class="game-detail-title-row">' +
                        '<img src="' + esc(coverSrc) + '" alt="' + esc(game.name) + ' cover" class="game-detail-cover" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                        '<div class="game-detail-title-meta">' +
                            '<div class="game-detail-title">' + esc(game.name) + '</div>' +
                            '<div class="game-detail-badges">' + releasedBadge + ratingBadge + '</div>' +
                        '</div>' +
                    '</div>' +
                    genreTagsHtml +
                    infoGridHtml +
                    descHtml +
                    trailerHtml +
                    shotsHtml +
                    '<div class="add-to-list">' +
                        '<h3>' + (ownedEntry ? 'In your library' : 'Add to My Library') + '</h3>' +
                        (ownedEntry ? '<p class="atl-owned-note">Saved as <strong>' +
                            esc(typeof statusLabel === 'function' ? statusLabel(ownedEntry.status, 'game') : (ownedEntry.status || '')) + '</strong>' +
                            (ownedEntry.score ? ', rated <strong>' + esc(String(ownedEntry.score)) + '/10</strong>' : ', not rated yet') +
                            '. Change it below.</p>' : '') +
                        '<div style="margin-bottom:12px;">' +
                            '<label>Add to list</label>' +
                            '<select id="gameListSelect" class="filter-select" style="width:100%;margin:0;" onchange="handleListSelectChange()">' +
                                '<option value="default">My Games Library (Default)</option>' +
                                customListOptions +
                            '</select>' +
                        '</div>' +
                        '<div class="atl-controls">' +
                            '<div class="atl-field atl-field-status">' +
                                '<label>Status</label>' +
                                '<select id="gameStatus" class="filter-select" style="width:100%;margin:0;">' +
                                    (typeof statusOptions === 'function'
                                      ? statusOptions('game', (ownedEntry && ownedEntry.status) || 'completed')
                                      : '<option value="playing">In progress</option>' +
                                    '<option value="completed" selected>Completed</option>' +
                                    '<option value="plan_to_play">Planned</option>' +
                                    '<option value="on_hold">On hold</option>' +
                                    '<option value="dropped">Dropped</option>') +
                                '</select>' +
                            '</div>' +
                            '<div class="atl-field">' +
                                '<label>Your score (1-10)</label>' +
                                '<div class="score-input-container" style="margin:0;">' +
                                    '<input type="number" id="gameScore" class="score-input" min="1" max="10" placeholder="--"' +
                                        (ownedEntry && ownedEntry.score ? ' value="' + esc(String(ownedEntry.score)) + '"' : '') + '>' +
                                    '<div class="score-controls">' +
                                        '<button type="button" class="score-btn" id="scoreUpBtn" aria-label="Increase score">+</button>' +
                                        '<button type="button" class="score-btn" id="scoreDownBtn" aria-label="Decrease score">−</button>' +
                                    '</div>' +
                                '</div>' +
                            '</div>' +
                            '<button class="btn btn-primary add-to-list-btn atl-add" data-game-id="' + game.id + '" data-game-data="' + gameDataStr + '">' +
                                (ownedEntry ? 'Save changes' : 'Add to Library') + '</button>' +
                        '</div>' +
                        '<div class="atl-note">' +
                            '<label for="gameNote">Review or note <span class="atl-optional">optional</span></label>' +
                            '<textarea id="gameNote" class="atl-note-input" rows="3" maxlength="2000" placeholder="Write a quick review or note, or leave it blank."></textarea>' +
                        '</div>' +
                        '<div id="customListNote" style="display:none;margin-top:12px;padding:10px 14px;background:var(--accent-dim);border:1px solid var(--accent-border);border-radius:var(--radius-md);font-size:0.82rem;color:var(--accent-light);">' +
                            'The game will be added to your selected custom list with the status above.' +
                        '</div>' +
                        '<span id="addGameMessage" style="display:block;margin-top:10px;font-size:13px;font-weight:600;"></span>' +
                    '</div>' +
                    seriesHtml +
                    similarHtml +
                '</div>';

            if (typeof openModal === 'function') openModal('gameModal');
            else document.getElementById('gameModal').style.display = 'flex';

            if (typeof bindScoreInput === 'function') bindScoreInput('gameScore', 'scoreUpBtn', 'scoreDownBtn', null);
            if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(document.getElementById('gameDetails'));
        }
    } catch (error) {
        console.error('Show game details error:', error);
    }
}

function handleListSelectChange() {
    var select = document.getElementById('gameListSelect');
    var note   = document.getElementById('customListNote');
    if (select && note) {
        note.style.display = select.value !== 'default' ? 'block' : 'none';
    }
}

async function addToList(gameId, gameData) {
    if (isGuest()) { promptSignIn('Create a free account to build your library.'); return; }
    var statusSelect = document.getElementById('gameStatus');
    var scoreInput   = document.getElementById('gameScore');
    var listSelect   = document.getElementById('gameListSelect');
    var messageEl    = document.getElementById('addGameMessage');
    var listValue    = listSelect   ? listSelect.value   : 'default';
    var noteInput    = document.getElementById('gameNote');
    var status       = statusSelect ? statusSelect.value : 'plan_to_play';
    var score        = scoreInput   ? scoreInput.value   : '';
    var note         = noteInput    ? noteInput.value.trim() : '';

    if (score && (parseInt(score) < 1 || parseInt(score) > 10)) {
        showInlineMsg(messageEl, 'Score must be between 1 and 10.', 'error');
        scoreInput.focus();
        return;
    }

    var ownedNow = typeof libraryEntry === 'function' ? libraryEntry(gameId) : null;

    if (listValue === 'default' && ownedNow && ownedNow.id) {
        // Editing what is already saved. A blank note box means "left alone",
        // never "delete what I wrote", so it is only sent when it has content.
        try {
            var patch = { status: status, score: score ? parseInt(score) : null };
            if (note) patch.notes = note;
            var up = await fetch(`${API_BASE}/user/games/${encodeURIComponent(ownedNow.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify(patch)
            });
            var ud = await up.json().catch(function () { return {}; });
            if (!up.ok) { showInlineMsg(messageEl, ud.error || 'Could not save that.', 'error'); return; }
            if (typeof setLibraryEntry === 'function') {
                setLibraryEntry(gameId, { id: ownedNow.id, status: status, score: score ? parseInt(score) : null });
            }
            if (typeof refreshOwnedBadge === 'function') refreshOwnedBadge(gameId);
            showInlineMsg(messageEl, 'Updated in your collection.', 'success');
        } catch (error) {
            showInlineMsg(messageEl, 'Network error. Please try again.', 'error');
        }
        return;
    }

    if (listValue === 'default') {
        try {
            var r = await fetch(`${API_BASE}/user/games`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({
                    game_id:   gameId,
                    game_data: gameData,
                    status:    status,
                    score:     score ? parseInt(score) : null,
                    notes:     note || undefined
                })
            });
            var d = await r.json();
            if (!r.ok) {
                if (d.error === 'Game already in your list') {
                    showInlineMsg(messageEl, 'Already in your collection.', 'success');
                } else {
                    showInlineMsg(messageEl, d.error || 'Failed to add game.', 'error');
                }
                return;
            }
            if (typeof setLibraryEntry === 'function') {
                setLibraryEntry(gameId, { id: d.game_id, status: status, score: score ? parseInt(score) : null });
            }
            if (typeof refreshOwnedBadge === 'function') refreshOwnedBadge(gameId);
            showInlineMsg(messageEl, 'Game added to your collection.', 'success');
            if (scoreInput)   scoreInput.value   = '';
            if (statusSelect) statusSelect.value = 'completed';
        } catch (error) {
            console.error('Add to collection error:', error);
            showInlineMsg(messageEl, 'Network error. Please try again.', 'error');
        }

    } else {
        var listId = listValue.replace('custom_', '');

        try {
            var addResp = await fetch(`${API_BASE}/user/games`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({
                    game_id:   gameId,
                    game_data: gameData,
                    status:    status,
                    score:     score ? parseInt(score) : null
                })
            });
            var addData = await addResp.json();
            var wasAlreadyInCollection = !addResp.ok && addData.error === 'Game already in your list';

            if (!addResp.ok && !wasAlreadyInCollection) {
                showInlineMsg(messageEl, addData.error || 'Failed to prepare game data.', 'error');
                return;
            }

            var gamesResp = await fetch(`${API_BASE}/user/games`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            if (!gamesResp.ok) {
                showInlineMsg(messageEl, 'Failed to retrieve game data.', 'error');
                return;
            }
            var gamesData    = await gamesResp.json();
            var matchedGame  = gamesData.games.find(function(g) {
                return gameData ? g.name === gameData.name : g.game_id == gameId;
            });

            if (!matchedGame) {
                showInlineMsg(messageEl, 'Could not locate game in database.', 'error');
                return;
            }

            if (!wasAlreadyInCollection) {
                await fetch(`${API_BASE}/user/games/${matchedGame.game_id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${authToken}` }
                });
            }

            var listResp = await fetch(`${API_BASE}/user/lists/${listId}/games`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({ game_id: matchedGame.game_id, status: status, score: score ? parseInt(score) : null, note: note || undefined })
            });
            var listData = await listResp.json();

            if (!listResp.ok) {
                if (listData.error === 'Game already in this list') {
                    showInlineMsg(messageEl, 'Already in that list.', 'success');
                } else {
                    showInlineMsg(messageEl, 'Failed to add to list: ' + listData.error, 'error');
                }
                return;
            }

            var matchedList = userCustomLists.find(function(l) { return l.id == listId; });
            var listName    = matchedList ? matchedList.name : 'list';
            showInlineMsg(messageEl, 'Game added to "' + listName + '".', 'success');
            if (scoreInput)   scoreInput.value   = '';
            if (statusSelect) statusSelect.value = 'completed';
            loadUserCustomLists();

        } catch (error) {
            console.error('Add to custom list error:', error);
            showInlineMsg(messageEl, 'Network error. Please try again.', 'error');
        }
    }
}

function showInlineMsg(el, text, type) {
    el.textContent = text;
    el.style.color = type === 'error' ? 'var(--red-light)' : 'var(--green-light)';
}

function populateFilterOptions() {
    var genreSelect = document.getElementById('genre');
    if (genreSelect) {
        var currentGenre = genreSelect.value;
        genreSelect.innerHTML = '<option value="">All Genres</option>';
        Array.from(allFilterOptions.genres).sort().forEach(function(genre) {
            genreSelect.innerHTML += '<option value="' + esc(genre) + '"' + (currentGenre === genre ? ' selected' : '') + '>' + esc(genre) + '</option>';
        });
    }

    var platformSelect = document.getElementById('platform');
    if (platformSelect) {
        var currentPlatform = platformSelect.value;
        platformSelect.innerHTML = '<option value="">All Platforms</option>';
        Array.from(allFilterOptions.platforms).sort().forEach(function(plat) {
            platformSelect.innerHTML += '<option value="' + esc(plat) + '"' + (currentPlatform === plat ? ' selected' : '') + '>' + esc(plat) + '</option>';
        });
    }

    var modeSelect = document.getElementById('gameMode');
    if (modeSelect) {
        var currentMode = modeSelect.value;
        modeSelect.innerHTML = '<option value="">All Modes</option>';
        Array.from(allFilterOptions.gameModes).sort().forEach(function(mode) {
            modeSelect.innerHTML += '<option value="' + esc(mode) + '"' + (currentMode === mode ? ' selected' : '') + '>' + esc(mode) + '</option>';
        });
    }
}

function toggleFilterSection() {
    document.getElementById('filterSection').classList.toggle('hidden');
}

function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }

function applyFilters() {
    currentFilters = {
        genre:     val('genre'),
        platform:  val('platform'),
        gameMode:  val('gameMode'),
        year:      val('year'),
        minRating: val('minRating'),
        search:    currentFilters.search || ''
    };
    currentPage  = 1;
    allGames     = [];
    hasMoreGames = true;
    retryCount   = 0;
    window.scrollTo(0, 0);
    fetchGames(true);
}

// Reset clears only the filter controls; the search box and sort are left alone.
function resetFilters() {
    ['genre', 'platform', 'gameMode', 'year', 'minRating'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var keptSearch = currentFilters.search || '';
    currentFilters = keptSearch ? { search: keptSearch } : {};
    currentPage    = 1;
    allGames       = [];
    hasMoreGames   = true;
    retryCount     = 0;
    window.scrollTo(0, 0);
    fetchGames(true);
}

function searchGames() {
    var searchTerm = document.getElementById('searchInput').value.trim();
    currentFilters.search = searchTerm;

    var sortBySelect = document.getElementById('sortBy');
    if (searchTerm) {
        sortBySelect.value = 'popularity-desc';
        currentSort      = 'popularity';
        currentSortOrder = 'desc';
    } else {
        sortBySelect.value = 'popularity-desc';
        currentSort      = 'popularity';
        currentSortOrder = 'desc';
    }

    currentPage  = 1;
    allGames     = [];
    hasMoreGames = true;
    retryCount   = 0;
    window.scrollTo(0, 0);
    fetchGames(true);
}

function goToPreviousPage() {
    if (currentPage <= 1 || isLoading) return;
    currentPage--;
    allGames     = [];
    hasMoreGames = true;
    retryCount   = 0;
    window.scrollTo(0, 0);
    fetchGames(true);
}

function goToNextPage() {
    if (!hasMoreGames || isLoading) return;
    currentPage++;
    allGames   = [];
    retryCount = 0;
    window.scrollTo(0, 0);
    fetchGames(true);
}

function updatePaginationButtons() {
    var prevPageBtn = document.getElementById('prevPageBtn');
    var nextPageBtn = document.getElementById('nextPageBtn');
    var pageInfo    = document.getElementById('pageInfo');

    if (prevPageBtn) prevPageBtn.disabled = currentPage <= 1;
    if (nextPageBtn) nextPageBtn.disabled = !hasMoreGames;
    if (pageInfo)    pageInfo.textContent = 'Page ' + currentPage;
}

function showError(element, message) {
    element.innerHTML = '<div class="error">' + esc(message) + '</div>';
}

function showSuccess(element, message) {
    element.innerHTML = '<div class="success">' + esc(message) + '</div>';
}

window.handleListSelectChange = handleListSelectChange;