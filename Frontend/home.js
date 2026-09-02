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
let gamesPerPage   = 20;
let apiGamesPerPage = 20;
let isLoading    = false;
let hasMoreGames = true;
let retryCount   = 0;
const maxRetries = 3;
let isVerifying  = false;

let userCustomLists = [];

let allFilterOptions = {
    genres:     new Set(),
    platforms:  new Set(),
    publishers: new Set(),
    developers: new Set()
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

        populateFilterOptions();
    } catch (error) {
        console.error('Error loading filters:', error);
    }
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
                publisher: currentFilters.publisher || undefined,
                developer: currentFilters.developer || undefined,
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

            collectFilterOptions(transformedGames);
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
        if (game.genres)     game.genres.forEach(function(g) { allFilterOptions.genres.add(g.name); });
        if (game.platforms)  game.platforms.forEach(function(p) { allFilterOptions.platforms.add(p.name); });
        if (game.publishers) game.publishers.forEach(function(p) { allFilterOptions.publishers.add(p.name); });
        if (game.developers) game.developers.forEach(function(d) { allFilterOptions.developers.add(d.name); });
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

        var genresHtml = (game.genres || []).slice(0, 3).map(function(g) {
            return '<span class="genre-tag">' + esc(g.name) + '</span>';
        }).join('');

        var platformsHtml = (game.platforms || []).slice(0, 3).map(function(p) {
            return '<span class="platform-badge">' + esc(p.name) + '</span>';
        }).join('');

        var descHtml = '';
        if (game.description) {
            var full = String(game.description);
            if (full.length > 110) {
                descHtml =
                    '<p class="game-card-desc">' +
                        '<span class="desc-short">' + esc(full.slice(0, 110)) + '…</span>' +
                        '<span class="desc-full hidden">' + esc(full) + '</span> ' +
                        '<button type="button" class="link-btn show-more-btn">Show more</button>' +
                    '</p>';
            } else {
                descHtml = '<p class="game-card-desc">' + esc(full) + '</p>';
            }
        }

        var cardLabel = 'View details for ' + (game.name || 'game');
        var ratingHtml = game.rating ? '<span class="card-rating">★ ' + esc(Number(game.rating).toFixed(1)) + '</span>' : '';
        return '<div class="game-card" data-game-id="' + esc(game.id) + '" role="button" tabindex="0" aria-label="' + esc(cardLabel) + '">' +
            '<div class="game-image-wrapper">' +
                '<img src="' + esc(imgSrc) + '" alt="' + esc(game.name || 'Game') + ' cover" class="game-image" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                ratingHtml +
            '</div>' +
            '<div class="game-info">' +
                '<div class="game-title">' + esc(game.name) + '</div>' +
                '<div class="game-card-meta">' + releasedHtml + '</div>' +
                '<div class="game-genres">' + genresHtml + '</div>' +
                (platformsHtml ? '<div class="game-platforms">' + platformsHtml + '</div>' : '') +
                descHtml +
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
                    developers:       developers
                };
            }
        } else {
            var resp = await fetch(`${API_BASE}/games/${gameId}`);
            game = await resp.json();
        }

        if (game) {
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
                    '<div class="add-to-list">' +
                        '<h3>Add to My Library</h3>' +
                        '<div style="margin-bottom:12px;">' +
                            '<label style="display:block;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:6px;">Add to List</label>' +
                            '<select id="gameListSelect" class="filter-select" style="width:100%;margin:0;" onchange="handleListSelectChange()">' +
                                '<option value="default">My Games Library (Default)</option>' +
                                customListOptions +
                            '</select>' +
                        '</div>' +
                        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">' +
                            '<div>' +
                                '<label style="display:block;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:6px;">Status</label>' +
                                '<select id="gameStatus" class="filter-select" style="width:100%;margin:0;">' +
                                    '<option value="playing">In progress</option>' +
                                    '<option value="completed" selected>Completed</option>' +
                                    '<option value="plan_to_play">Planned</option>' +
                                    '<option value="on_hold">On hold</option>' +
                                    '<option value="dropped">Dropped</option>' +
                                '</select>' +
                            '</div>' +
                            '<div>' +
                                '<label style="display:block;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:6px;">Your Score (1-10)</label>' +
                                '<div class="score-input-container" style="margin:0;">' +
                                    '<input type="number" id="gameScore" class="score-input" min="1" max="10" placeholder="--" style="width:100%;">' +
                                    '<div class="score-controls">' +
                                        '<button type="button" class="score-btn" id="scoreUpBtn" aria-label="Increase score">+</button>' +
                                        '<button type="button" class="score-btn" id="scoreDownBtn" aria-label="Decrease score">−</button>' +
                                    '</div>' +
                                    '<button type="button" class="btn btn-sm score-clear-btn" id="scoreClearBtn">No Score</button>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div id="customListNote" style="display:none;margin-bottom:12px;padding:10px 14px;background:var(--accent-dim);border:1px solid var(--accent-border);border-radius:var(--radius-md);font-size:0.82rem;color:var(--accent-light);">' +
                            'The game will be added to your selected custom list with the status above.' +
                        '</div>' +
                        '<div style="display:flex;align-items:center;gap:12px;">' +
                            '<button class="btn btn-primary btn-sm add-to-list-btn" data-game-id="' + game.id + '" data-game-data="' + gameDataStr + '" style="flex-shrink:0;white-space:nowrap;">Add to List</button>' +
                            '<span id="addGameMessage" style="font-size:13px;font-weight:600;"></span>' +
                        '</div>' +
                    '</div>' +
                '</div>';

            if (typeof openModal === 'function') openModal('gameModal');
            else document.getElementById('gameModal').style.display = 'flex';

            if (typeof bindScoreInput === 'function') bindScoreInput('gameScore', 'scoreUpBtn', 'scoreDownBtn', 'scoreClearBtn');
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
    var status       = statusSelect ? statusSelect.value : 'plan_to_play';
    var score        = scoreInput   ? scoreInput.value   : '';

    if (score && (parseInt(score) < 1 || parseInt(score) > 10)) {
        showInlineMsg(messageEl, 'Score must be between 1 and 10.', 'error');
        scoreInput.focus();
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
                    score:     score ? parseInt(score) : null
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
                body: JSON.stringify({ game_id: matchedGame.game_id, status: status, score: score ? parseInt(score) : null })
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
    var currentGenre     = document.getElementById('genre').value;
    var currentPlatform  = document.getElementById('platform').value;
    var currentPublisher = document.getElementById('publisher').value;
    var currentDeveloper = document.getElementById('developer').value;

    var genreSelect = document.getElementById('genre');
    genreSelect.innerHTML = '<option value="">All Genres</option>';
    Array.from(allFilterOptions.genres).sort().forEach(function(genre) {
        genreSelect.innerHTML += '<option value="' + esc(genre) + '"' + (currentGenre === genre ? ' selected' : '') + '>' + esc(genre) + '</option>';
    });

    var platformSelect = document.getElementById('platform');
    platformSelect.innerHTML = '<option value="">All Platforms</option>';
    Array.from(allFilterOptions.platforms).sort().forEach(function(plat) {
        platformSelect.innerHTML += '<option value="' + esc(plat) + '"' + (currentPlatform === plat ? ' selected' : '') + '>' + esc(plat) + '</option>';
    });

    var publisherSelect = document.getElementById('publisher');
    publisherSelect.innerHTML = '<option value="">All Publishers</option>';
    Array.from(allFilterOptions.publishers).sort().forEach(function(pub) {
        publisherSelect.innerHTML += '<option value="' + esc(pub) + '"' + (currentPublisher === pub ? ' selected' : '') + '>' + esc(pub) + '</option>';
    });

    var developerSelect = document.getElementById('developer');
    developerSelect.innerHTML = '<option value="">All Developers</option>';
    Array.from(allFilterOptions.developers).sort().forEach(function(dev) {
        developerSelect.innerHTML += '<option value="' + esc(dev) + '"' + (currentDeveloper === dev ? ' selected' : '') + '>' + esc(dev) + '</option>';
    });
}

function toggleFilterSection() {
    document.getElementById('filterSection').classList.toggle('hidden');
}

function applyFilters() {
    currentFilters = {
        genre:     document.getElementById('genre').value,
        platform:  document.getElementById('platform').value,
        publisher: document.getElementById('publisher').value,
        developer: document.getElementById('developer').value,
        search:    currentFilters.search || ''
    };
    currentPage  = 1;
    allGames     = [];
    hasMoreGames = true;
    retryCount   = 0;
    window.scrollTo(0, 0);
    fetchGames(true);
}

function resetFilters() {
    document.getElementById('genre').value       = '';
    document.getElementById('platform').value    = '';
    document.getElementById('publisher').value   = '';
    document.getElementById('developer').value   = '';
    document.getElementById('searchInput').value = '';
    currentFilters = {};
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