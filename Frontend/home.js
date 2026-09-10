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

    /* The plus on a card saves straight from the grid. It sits on top of the
       card's own activation, so it stops the click before the card can
       navigate - clicking anywhere else still opens the full page. */
    if (window.MGLQuickAdd) {
        window.MGLQuickAdd.bind(
            document.getElementById('searchResults'),
            function (ref) {
                return allGames.find(function (g) { return String(g.id) === String(ref); }) || null;
            },
            'game'
        );
    }

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

    // Old ?open=igdb_<id> links (bookmarks, shared URLs) still work: titles
    // have their own page now, so this just forwards there.
    var openRef = new URLSearchParams(window.location.search).get('open');
    if (openRef && /^igdb_\d+$/i.test(openRef)) showGameDetails(openRef);
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



/* Studio names in the info grid, each leading to that studio's own page where
   IGDB knows which one it is. A company with no id stays plain text rather than
   becoming a link that goes nowhere. */
function companyListHtml(companies) {
    return (companies || []).map(function (c) {
        return c.ref
            ? '<a class="info-link" href="person.html?ref=' + esc(c.ref) + '">' + esc(c.name) + '</a>'
            : esc(c.name);
    }).join(', ');
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
        // summary all live on the title's own page.
        var cardLabel = 'View details for ' + (game.name || 'game');
        var ratingHtml = game.rating ? '<span class="card-rating">★ ' + esc(Number(game.rating).toFixed(1)) + '</span>' : '';
        // Says "you already have this" before the user adds it a second time.
        var ownedHtml = typeof ownedBadgeHtml === 'function' ? ownedBadgeHtml(game.id) : '';
        // Saves from the grid without opening (and paying for) the full title.
        var quickHtml = window.MGLQuickAdd
            ? window.MGLQuickAdd.buttonHtml(game.id, typeof libraryEntry === 'function' && !!libraryEntry(game.id))
            : '';
        return '<div class="game-card" data-game-id="' + esc(game.id) + '" role="button" tabindex="0" aria-label="' + esc(cardLabel) + '">' +
            '<div class="game-image-wrapper">' +
                '<img src="' + esc(imgSrc) + '" alt="' + esc(game.name || 'Game') + ' cover" class="game-image" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                ratingHtml + ownedHtml + quickHtml +
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
/* Opening a game is a navigation, not an overlay.

   This used to build the whole detail view into a modal over the grid. A title
   now has its own address, so it can be linked, shared, opened in a new tab and
   left with the browser's own Back - and on a phone it is a page rather than a
   scrolling box inside one. title.js renders every category from the same code,
   which is why the games-only copy of this is gone. */
function showGameDetails(gameId) {
    if (!gameId) return;
    window.location.href = 'title.html?ref=' + encodeURIComponent(gameId);
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

