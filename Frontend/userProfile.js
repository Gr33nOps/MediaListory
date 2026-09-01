const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '/api';

let authToken     = localStorage.getItem('authToken');
let currentUser   = (typeof getStoredUser === 'function') ? getStoredUser() : null;
let viewingUserId = null;
let followStatus  = { isFollowing: false, followsYou: false };

let userGamesCache      = [];
let currentSort         = 'recently_added';
let currentStatusFilter = 'all';
let currentSearchTerm   = '';

let upLists          = [];
let upListGames      = {};
let upExpandedListId = null;
let upFilters        = {};

var STATUS_LABEL = {
    playing:      'Playing',
    completed:    'Completed',
    plan_to_play: 'Plan to Play',
    on_hold:      'On Hold',
    dropped:      'Dropped'
};

var STATUS_COLOR = {
    playing:      '#3498db',
    completed:    '#2ecc71',
    plan_to_play: '#9b59b6',
    on_hold:      '#f39c12',
    dropped:      '#e74c3c'
};

(async function bootUserProfile() {
    if (typeof ensureSession === 'function') {
        try { await ensureSession(); } catch (_) {}
    }
    authToken = localStorage.getItem('authToken');
    currentUser = (typeof getStoredUser === 'function') ? getStoredUser() : null;
    if (!authToken) {
        window.location.href = (typeof authUrlWithNext === 'function' ? authUrlWithNext() : 'auth.html');
        return;
    }
    verifyToken();
})();

async function verifyToken() {
    try {
        var r = await fetch(`${API_BASE}/auth/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (r.ok) {
            var d = await r.json();
            currentUser = d.user;
            localStorage.setItem('currentUser', JSON.stringify(d.user));
            initPage();
        } else if (r.status === 401 || r.status === 403) {
            logout();
        } else if (currentUser) {
            initPage();
        }
    } catch (e) {
        console.error('Verify token error:', e);
        if (currentUser) initPage();
    }
}

function initPage() {
    var urlParams = new URLSearchParams(window.location.search);
    viewingUserId = urlParams.get('userId');

    if (!viewingUserId) {
        notify('Invalid user ID. Redirecting to friends page.');
        window.location.href = 'friends.html';
        return;
    }

    if (viewingUserId === currentUser.id) {
        window.location.href = 'profile.html';
        return;
    }

    document.querySelectorAll('.page-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.page-tab').forEach(function(t) {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
                t.tabIndex = -1;
            });
            document.querySelectorAll('.tab-panel').forEach(function(p) {
                p.classList.remove('active');
                p.hidden = true;
            });
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            tab.tabIndex = 0;
            var panel = document.getElementById('tab-' + tab.dataset.tab);
            if (panel) {
                panel.classList.add('active');
                panel.hidden = false;
            }
            if (tab.dataset.tab === 'lists' && upLists.length === 0) {
                upLoadLists();
            }
        });
    });

    document.getElementById('userGamesSort').addEventListener('change', function(e) {
        currentSort = e.target.value;
        displayUserGames(sortGames(userGamesCache));
    });

    document.getElementById('userGamesSearch').addEventListener('input', function(e) {
        currentSearchTerm = e.target.value.toLowerCase().trim();
        displayUserGames(sortGames(userGamesCache));
    });

    document.querySelectorAll('#tab-collection .status-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('#tab-collection .status-tab').forEach(function(t) { t.classList.remove('active'); });
            tab.classList.add('active');
            currentStatusFilter = tab.dataset.status;
            displayUserGames(sortGames(userGamesCache));
        });
    });

    if (typeof bindModal === 'function') bindModal('gameModal', 'closeModalBtn');
    else document.getElementById('closeModalBtn').addEventListener('click', function() {
        document.getElementById('gameModal').style.display = 'none';
    });
    document.getElementById('gameModal').addEventListener('click', function(e) {
        if (e.target.id === 'gameModal' && typeof closeModal === 'function') closeModal('gameModal');
    });

    document.getElementById('clGameModal').addEventListener('click', function(e) {
        if (e.target.id === 'clGameModal') upCloseModal('clGameModal');
    });
    document.getElementById('clGameModalClose').addEventListener('click', function() { upCloseModal('clGameModal'); });

    if (typeof bindActivatableCards === 'function') {
        bindActivatableCards(document, '.coll-item.list-item', function(listItem) {
            showGameDetails(listItem.dataset.gameId);
        });
    } else {
        document.addEventListener('click', function(e) {
            var listItem = e.target.closest('.coll-item.list-item');
            if (listItem && !e.target.classList.contains('btn')) {
                showGameDetails(listItem.dataset.gameId);
            }
        });
    }

    document.getElementById('shareProfileBtn').addEventListener('click', copyShareLink);

    loadUserProfile();
    loadUserGames();
}

async function loadUserProfile() {
    try {
        var r = await fetch(`${API_BASE}/users/${viewingUserId}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) {
            var d = await r.json();
            displayUserProfile(d.user);
            await checkFollowStatus();
        } else {
            notify('Failed to load user profile.');
            window.location.href = 'friends.html';
        }
    } catch (e) {
        console.error('Load user profile error:', e);
        window.location.href = 'friends.html';
    }
}

function displayUserProfile(user) {
    var avatarUrl = user.avatar_url ||
        'https://ui-avatars.com/api/?name=' + encodeURIComponent(user.display_name || user.username) + '&size=200&background=3b82f6&color=fff&bold=true';

    document.getElementById('profileTitle').textContent     = (user.display_name || user.username) + "'s Profile";
    document.getElementById('gameListTitle').textContent    = (user.display_name || user.username) + "'s Library";
    if (user.mediaBreakdown) {
        var bd = user.mediaBreakdown;
        var titleEl = document.getElementById('gameListTitle');
        var existing = document.getElementById('mediaBreakdownLine');
        if (existing) existing.remove();
        var line = document.createElement('div');
        line.id = 'mediaBreakdownLine';
        line.style.cssText = 'font-size:0.82rem;color:#94a3b8;margin-top:4px;';
        line.textContent = (bd.game || 0) + ' games · ' + (bd.movie || 0) + ' movies · ' + (bd.series || 0) + ' series';
        if (titleEl && titleEl.parentNode) titleEl.parentNode.insertBefore(line, titleEl.nextSibling);
    }
    document.getElementById('customListsTitle').textContent = (user.display_name || user.username) + "'s Lists";
    document.getElementById('userAvatar').src               = avatarUrl;
    document.getElementById('displayName').textContent      = user.display_name || '-';
    document.getElementById('displayUsername').textContent  = user.username;
    document.getElementById('displayCreatedAt').textContent = formatDate(user.created_at);
    document.getElementById('totalGames').textContent       = user.totalGames     || 0;
    document.getElementById('userLevel').textContent        = calculateLevel(user.totalGames || 0);
    document.getElementById('followersCount').textContent   = user.followersCount || 0;
    document.getElementById('followingCount').textContent   = user.followingCount || 0;
}

async function loadUserGames() {
    try {
        var r = await fetch(`${API_BASE}/users/${viewingUserId}/games`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) {
            var d = await r.json();
            userGamesCache = d.games;
            displayUserGames(sortGames(userGamesCache));
        } else {
            console.error('Failed to load games');
        }
    } catch (e) {
        console.error('Load user games error:', e);
    }
}

function sortGames(games) {
    var s = games.slice();
    switch (currentSort) {
        case 'recently_added':
            s.sort(function(a, b) { return a.date_added && b.date_added ? new Date(b.date_added) - new Date(a.date_added) : 0; });
            break;
        case 'name':        s.sort(function(a, b) { return a.name.localeCompare(b.name); }); break;
        case 'name_desc':   s.sort(function(a, b) { return b.name.localeCompare(a.name); }); break;
        case 'score_high':  s.sort(function(a, b) { return (b.score  || 0) - (a.score  || 0); }); break;
        case 'score_low':   s.sort(function(a, b) { return (a.score  || 0) - (b.score  || 0); }); break;
        case 'rating_high': s.sort(function(a, b) { return (b.rating || 0) - (a.rating || 0); }); break;
        case 'rating_low':  s.sort(function(a, b) { return (a.rating || 0) - (b.rating || 0); }); break;
    }
    return s;
}

function displayUserGames(games) {
    var container = document.getElementById('userGamesList');
    var filtered  = games;

    if (currentStatusFilter !== 'all') {
        filtered = filtered.filter(function(g) { return g.status === currentStatusFilter; });
    }
    if (currentSearchTerm) {
        filtered = filtered.filter(function(g) { return g.name.toLowerCase().includes(currentSearchTerm); });
    }

    if (filtered.length === 0) {
        var escFn = typeof esc === 'function' ? esc : function (s) { return String(s || ''); };
        var term = escFn(currentSearchTerm);
        var statusLbl = escFn(STATUS_LABEL[currentStatusFilter] || currentStatusFilter);
        var msg = 'This user has no games in their collection yet.';
        if (currentSearchTerm && currentStatusFilter !== 'all')
            msg = 'No games matching "' + term + '" with status "' + statusLbl + '".';
        else if (currentSearchTerm)
            msg = 'No games matching "' + term + '".';
        else if (currentStatusFilter !== 'all')
            msg = 'No games with status "' + statusLbl + '".';
        container.innerHTML = '<div class="coll-empty-state"><div class="coll-empty-icon">No games found</div><p>' + msg + '</p></div>';
        return;
    }

    container.innerHTML = filtered.map(function(game) { return renderCollectionRow(game); }).join('');
}

function renderCollectionRow(game) {
    var mediaType   = game.media_type || 'game';
    var statusColor = STATUS_COLOR[game.status] || '#666';
    var statusText  = (typeof statusLabel === 'function') ? statusLabel(game.status, mediaType) : (STATUS_LABEL[game.status] || game.status);
    var typeText    = (typeof mediaTypeLabel === 'function') ? mediaTypeLabel(mediaType) : mediaType;
    var imgSrc      = game.background_image || '/img/no-image.svg';

    return '<div class="coll-item list-item" data-game-id="' + esc(game.id) + '" role="button" tabindex="0" aria-label="' + esc('View details for ' + (game.name || 'title')) + '">' +
        '<img src="' + esc(imgSrc) + '" alt="' + esc(game.name || 'Cover') + '" class="coll-item-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
        '<div class="coll-item-body">' +
            '<div class="coll-item-main">' +
                '<div class="coll-item-name">' + esc(game.name) + '</div>' +
                '<div class="coll-item-meta">' +
                    '<span class="media-type-pill media-type-' + esc(mediaType) + '">' + esc(typeText) + '</span>' +
                    '<span class="status-dot-inline" style="background:' + statusColor + ';"></span>' +
                    '<span class="coll-item-status">' + esc(statusText) + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="coll-item-right">' +
                '<div class="coll-score-badge">' + (game.score ? game.score : '-') + '</div>' +
            '</div>' +
        '</div>' +
    '</div>';
}

async function showGameDetails(gameId) {
    var ref = String(gameId);
    // Movies / series come from TMDB and are returned already normalized.
    var tmdbMatch = ref.match(/^tmdb_(movie|series)_(\d+)$/);
    if (tmdbMatch) { return showTmdbDetails(tmdbMatch[1], Number(tmdbMatch[2])); }
    try {
        var igdbId = ref.replace('igdb_', '');

        var r = await fetch(`${API_BASE}/igdb/games`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + authToken
            },
            body: JSON.stringify({ id: Number(igdbId) })
        });

        var igdbGames = await r.json();
        if (!r.ok || !igdbGames.length) return;

        var ig         = igdbGames[0];
        var publishers = [];
        var developers = [];
        (ig.involved_companies || []).forEach(function(ic) {
            if (ic.company) {
                if (ic.publisher) publishers.push(ic.company.name);
                if (ic.developer) developers.push(ic.company.name);
            }
        });

        var score = null;
        if (ig.total_rating && ig.total_rating_count >= 5)           score = Math.round(ig.total_rating);
        else if (ig.aggregated_rating && ig.aggregated_rating_count >= 3) score = Math.round(ig.aggregated_rating);

        var rc       = !score ? '#666' : score >= 90 ? '#10b981' : score >= 75 ? '#3b82f6' : score >= 50 ? '#f59e0b' : '#ef4444';
        var coverUrl = ig.cover
            ? 'https:' + ig.cover.url.replace('t_thumb', 't_cover_big')
            : '/img/no-image.svg';

        var released = ig.first_release_date
            ? new Date(ig.first_release_date * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : null;

        var infoItems = [
            released          ? { label: 'Released',  value: released }                                           : null,
            publishers.length ? { label: 'Publisher', value: publishers.join(', ') }                              : null,
            developers.length ? { label: 'Developer', value: developers.join(', ') }                              : null,
            ig.platforms && ig.platforms.length ? { label: 'Platforms', value: ig.platforms.map(function(p) { return p.name; }).join(' / ') } : null
        ].filter(Boolean);

        var genreTagsHtml = (ig.genres || []).length
            ? '<div class="game-detail-genres">' + ig.genres.map(function(g) { return '<span class="game-detail-genre-tag">' + esc(g.name) + '</span>'; }).join('') + '</div>'
            : '';

        var infoGridHtml = infoItems.length
            ? '<div class="game-detail-info-grid">' + infoItems.map(function(i) { return '<div class="game-detail-info-item"><div class="game-detail-info-label">' + i.label + '</div><div class="game-detail-info-value">' + i.value + '</div></div>'; }).join('') + '</div>'
            : '';

        var scoreSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

        document.getElementById('gameDetails').innerHTML =
            '<div class="game-detail-hero">' +
                '<img src="' + coverUrl + '" alt="' + esc(ig.name) + ' banner" class="game-detail-hero-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
            '</div>' +
            '<div class="game-detail-body">' +
                '<div class="game-detail-title-row">' +
                    '<img src="' + coverUrl + '" alt="' + esc(ig.name) + ' cover" class="game-detail-cover" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                    '<div class="game-detail-title-meta">' +
                        '<div class="game-detail-title">' + esc(ig.name) + '</div>' +
                        '<div class="game-detail-badges">' +
                            '<span class="game-detail-score" style="background:' + rc + ';">' + scoreSvg + ' ' + (score ? score + '/100' : 'No Rating') + '</span>' +
                            (released ? '<span class="game-detail-date">' + released + '</span>' : '') +
                        '</div>' +
                    '</div>' +
                '</div>' +
                genreTagsHtml +
                infoGridHtml +
                (ig.summary ? '<p class="game-detail-desc">' + esc(ig.summary) + '</p>' : '') +
            '</div>';

        if (typeof openModal === 'function') openModal('gameModal');
        else document.getElementById('gameModal').style.display = 'flex';
    } catch (e) {
        console.error('Show game details error:', e);
    }
}

async function showTmdbDetails(kind, tmdbId) {
    try {
        var endpoint = kind === 'series' ? '/tmdb/series' : '/tmdb/movies';
        var r = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
            body: JSON.stringify({ id: tmdbId })
        });
        var arr = await r.json();
        if (!r.ok || !Array.isArray(arr) || !arr.length) return;
        var m = arr[0];

        var heroBg = m.backdrop_image || m.background_image || '/img/no-image.svg';
        var coverUrl = m.background_image || heroBg;
        var released = m.released ? new Date(m.released).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
        var creditLabel = kind === 'series' ? 'Creator' : 'Director';
        var studioLabel = kind === 'series' ? 'Network' : 'Studio';
        var names = function(list) { return (list || []).map(function(x) { return x.name || x; }).filter(Boolean); };

        var infoItems = [
            released ? { label: 'Released', value: released } : null,
            names(m.developers).length ? { label: creditLabel, value: names(m.developers).join(', ') } : null,
            names(m.publishers).length ? { label: studioLabel, value: names(m.publishers).join(', ') } : null
        ].filter(Boolean);

        var genreTagsHtml = (m.genres || []).length
            ? '<div class="game-detail-genres">' + m.genres.map(function(g) { return '<span class="game-detail-genre-tag">' + esc(g.name || g) + '</span>'; }).join('') + '</div>'
            : '';
        var infoGridHtml = infoItems.length
            ? '<div class="game-detail-info-grid">' + infoItems.map(function(i) { return '<div class="game-detail-info-item"><div class="game-detail-info-label">' + esc(i.label) + '</div><div class="game-detail-info-value">' + esc(i.value) + '</div></div>'; }).join('') + '</div>'
            : '';

        document.getElementById('gameDetails').innerHTML =
            '<div class="game-detail-hero"><img src="' + esc(heroBg) + '" alt="' + esc(m.name) + ' banner" class="game-detail-hero-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'"></div>' +
            '<div class="game-detail-body">' +
                '<div class="game-detail-title-row">' +
                    '<img src="' + esc(coverUrl) + '" alt="' + esc(m.name) + ' cover" class="game-detail-cover" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                    '<div class="game-detail-title-meta">' +
                        '<div class="game-detail-title">' + esc(m.name) + '</div>' +
                        '<div class="game-detail-badges">' + (released ? '<span class="game-detail-date">' + esc(released) + '</span>' : '') + '</div>' +
                    '</div>' +
                '</div>' + genreTagsHtml + infoGridHtml +
                (m.description ? '<p class="game-detail-desc">' + esc(m.description) + '</p>' : '') +
            '</div>';

        if (typeof openModal === 'function') openModal('gameModal');
        else document.getElementById('gameModal').style.display = 'flex';
    } catch (e) {
        console.error('Show TMDB details error:', e);
    }
}

function closeGameModal() {
    if (typeof closeModal === 'function') closeModal('gameModal');
    else document.getElementById('gameModal').style.display = 'none';
}

async function upLoadLists() {
    try {
        var r = await fetch(`${API_BASE}/users/${viewingUserId}/lists`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (!r.ok) throw new Error((await r.json()).error || 'HTTP ' + r.status);
        var d = await r.json();
        upLists = d.lists;
        upRenderAccordion();
    } catch (e) {
        upShowToast(e.message, 'error');
    }
}

function upRenderAccordion() {
    var container = document.getElementById('upAccordion');
    if (upLists.length === 0) {
        container.innerHTML = '<div class="coll-empty-state"><div class="coll-empty-icon">No lists</div><p>This user has no public lists yet.</p></div>';
        return;
    }
    container.innerHTML = upLists.map(function(list) { return upRenderAccordionRow(list); }).join('');

    container.querySelectorAll('.up-acc-header').forEach(function(header) {
        header.addEventListener('click', function() {
            var listId = parseInt(header.closest('.cl-acc-row').dataset.listId);
            upToggleAccordion(listId);
        });
    });

    if (upExpandedListId) {
        var row = container.querySelector('.cl-acc-row[data-list-id="' + upExpandedListId + '"]');
        if (row) upExpandRow(row, upExpandedListId, false);
    }
}

function upRenderAccordionRow(list) {
    var count      = list.game_count || 0;
    var isExpanded = upExpandedListId === list.id;
    return '<div class="cl-acc-row ' + (isExpanded ? 'expanded' : '') + '" data-list-id="' + list.id + '">' +
        '<div class="up-acc-header cl-acc-header">' +
            '<div class="cl-acc-header-left">' +
                '<span class="cl-acc-chevron">' + (isExpanded ? 'v' : '>') + '</span>' +
                '<div class="cl-acc-title-group">' +
                    '<div class="cl-acc-title-row">' +
                        '<span class="cl-acc-name">' + esc(list.name) + '</span>' +
                        '<span class="pill">' + count + ' ' + (count === 1 ? 'game' : 'games') + '</span>' +
                    '</div>' +
                    (list.description ? '<div class="cl-acc-desc">' + esc(list.description) + '</div>' : '') +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="cl-acc-body ' + (isExpanded ? '' : 'hidden') + '" id="up-acc-body-' + list.id + '"></div>' +
    '</div>';
}

async function upToggleAccordion(listId) {
    var container = document.getElementById('upAccordion');
    var row = container.querySelector('.cl-acc-row[data-list-id="' + listId + '"]');
    if (!row) return;

    var isCurrentlyExpanded = upExpandedListId === listId;

    container.querySelectorAll('.cl-acc-row').forEach(function(r) {
        r.classList.remove('expanded');
        r.querySelector('.cl-acc-chevron').textContent = '>';
        r.querySelector('.cl-acc-body').classList.add('hidden');
    });

    if (isCurrentlyExpanded) { upExpandedListId = null; return; }

    upExpandedListId = listId;
    upExpandRow(row, listId, true);
}

async function upExpandRow(row, listId, doFetch) {
    row.classList.add('expanded');
    row.querySelector('.cl-acc-chevron').textContent = 'v';
    var body = row.querySelector('.cl-acc-body');
    body.classList.remove('hidden');

    if (!upFilters[listId]) {
        upFilters[listId] = { search: '', sort: 'recently_added', status: 'all' };
    }

    if (doFetch || !upListGames[listId]) {
        body.innerHTML = '<div class="coll-empty-state"><p>Loading...</p></div>';
        try {
            var r = await fetch(`${API_BASE}/users/${viewingUserId}/lists/${listId}`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            if (!r.ok) throw new Error((await r.json()).error || 'HTTP ' + r.status);
            var d = await r.json();
            upListGames[listId] = d.list.games || [];
        } catch (e) {
            body.innerHTML = '<div class="coll-empty-state"><p>Failed to load games.</p></div>';
            return;
        }
    }

    upRenderListBody(listId);
}

function upRenderListBody(listId) {
    var body = document.getElementById('up-acc-body-' + listId);
    if (!body) return;
    var f = upFilters[listId];

    var statusOptions = ['all', 'playing', 'completed', 'plan_to_play', 'on_hold', 'dropped'];
    var statusTabsHtml = statusOptions.map(function(s) {
        return '<button class="status-tab ' + (f.status === s ? 'active' : '') + '" data-status="' + s + '">' + (s === 'all' ? 'All Games' : STATUS_LABEL[s]) + '</button>';
    }).join('');

    body.innerHTML =
        '<div class="cl-acc-toolbar">' +
            '<div class="cl-acc-list-header">' +
                '<div class="cl-acc-list-header-inputs">' +
                    '<input type="text" class="search-input up-acc-search" placeholder="Search games..." value="' + esc(f.search) + '">' +
                    '<select class="filter-select up-acc-sort">' +
                        '<option value="recently_added"' + (f.sort === 'recently_added' ? ' selected' : '') + '>Recently Added</option>' +
                        '<option value="name"'          + (f.sort === 'name'           ? ' selected' : '') + '>Name (A-Z)</option>' +
                        '<option value="name_desc"'     + (f.sort === 'name_desc'      ? ' selected' : '') + '>Name (Z-A)</option>' +
                        '<option value="score_high"'    + (f.sort === 'score_high'     ? ' selected' : '') + '>Score (High to Low)</option>' +
                        '<option value="score_low"'     + (f.sort === 'score_low'      ? ' selected' : '') + '>Score (Low to High)</option>' +
                    '</select>' +
                '</div>' +
            '</div>' +
            '<div class="status-tabs cl-acc-status-tabs">' + statusTabsHtml + '</div>' +
        '</div>' +
        '<div class="my-games-list" id="up-acc-games-' + listId + '"></div>';

    body.querySelector('.up-acc-search').addEventListener('input', function(e) { upFilters[listId].search = e.target.value.toLowerCase().trim(); upRenderAccGames(listId); });
    body.querySelector('.up-acc-sort').addEventListener('change', function(e) { upFilters[listId].sort = e.target.value; upRenderAccGames(listId); });
    body.querySelectorAll('.cl-acc-status-tabs .status-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            upFilters[listId].status = tab.dataset.status;
            body.querySelectorAll('.cl-acc-status-tabs .status-tab').forEach(function(t) { t.classList.remove('active'); });
            tab.classList.add('active');
            upRenderAccGames(listId);
        });
    });

    upRenderAccGames(listId);
}

function upRenderAccGames(listId) {
    var container = document.getElementById('up-acc-games-' + listId);
    if (!container) return;
    var f     = upFilters[listId];
    var games = (upListGames[listId] || []).slice();

    if (f.status !== 'all') games = games.filter(function(g) { return g.status === f.status; });
    if (f.search)           games = games.filter(function(g) { return g.name.toLowerCase().includes(f.search); });

    switch (f.sort) {
        case 'name':           games.sort(function(a, b) { return a.name.localeCompare(b.name); }); break;
        case 'name_desc':      games.sort(function(a, b) { return b.name.localeCompare(a.name); }); break;
        case 'score_high':     games.sort(function(a, b) { return (b.user_score || 0) - (a.user_score || 0); }); break;
        case 'score_low':      games.sort(function(a, b) { return (a.user_score || 0) - (b.user_score || 0); }); break;
        case 'recently_added':
        default:               games.sort(function(a, b) { return new Date(b.added_at || 0) - new Date(a.added_at || 0); }); break;
    }

    if (games.length === 0) {
        var msg = f.search
            ? 'No games matching "' + f.search + '".'
            : f.status !== 'all'
                ? 'No games with status "' + (STATUS_LABEL[f.status] || f.status) + '".'
                : 'No games in this list yet.';
        container.innerHTML = '<div class="coll-empty-state" style="padding:30px 20px;"><p>' + msg + '</p></div>';
        return;
    }

    container.innerHTML = games.map(function(g) { return upRenderGameRow(g); }).join('');
    container.querySelectorAll('.cl-list-item[data-game-id]').forEach(function(row) {
        row.addEventListener('click', function() { upShowGameDetails(row.dataset.gameId); });
    });
}

function upRenderGameRow(g) {
    var score       = g.user_score ? g.user_score : '-';
    var statusColor = STATUS_COLOR[g.status] || '#555';
    var statusLabel = STATUS_LABEL[g.status] || (g.status ? g.status : 'No Status');
    var imgSrc      = g.background_image || '/img/no-image.svg';

    var statusMetaHtml = statusLabel !== 'No Status'
        ? '<span class="status-dot-inline" style="background:' + statusColor + ';"></span><span class="coll-item-status">' + statusLabel + '</span>'
        : '<span class="coll-item-status" style="color:var(--text-dim);">No status</span>';

    return '<div class="coll-item cl-list-item" data-game-id="' + esc(g.game_id) + '">' +
        '<img src="' + imgSrc + '" alt="' + esc(g.name) + '" class="coll-item-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
        '<div class="coll-item-body">' +
            '<div class="coll-item-main">' +
                '<div class="coll-item-name">' + esc(g.name) + '</div>' +
                '<div class="coll-item-meta">' + statusMetaHtml + '</div>' +
            '</div>' +
            '<div class="coll-item-right"><div class="coll-score-badge">' + score + '</div></div>' +
        '</div>' +
    '</div>';
}

async function upShowGameDetails(gameId) {
    try {
        var igdbId = String(gameId).replace('igdb_', '');

        var r = await fetch(`${API_BASE}/igdb/games`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + authToken
            },
            body: JSON.stringify({ id: Number(igdbId) })
        });

        var igdbGames = await r.json();
        if (!r.ok || !igdbGames.length) return;

        var ig         = igdbGames[0];
        var publishers = [];
        var developers = [];
        (ig.involved_companies || []).forEach(function(ic) {
            if (ic.company) {
                if (ic.publisher) publishers.push(ic.company.name);
                if (ic.developer) developers.push(ic.company.name);
            }
        });

        var score = null;
        if (ig.total_rating && ig.total_rating_count >= 5)           score = Math.round(ig.total_rating);
        else if (ig.aggregated_rating && ig.aggregated_rating_count >= 3) score = Math.round(ig.aggregated_rating);

        var rc       = !score ? '#666' : score >= 90 ? '#10b981' : score >= 75 ? '#3b82f6' : score >= 50 ? '#f59e0b' : '#ef4444';
        var coverUrl = ig.cover
            ? 'https:' + ig.cover.url.replace('t_thumb', 't_cover_big')
            : '/img/no-image.svg';

        var released = ig.first_release_date
            ? new Date(ig.first_release_date * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : null;

        var infoItems = [
            released          ? { label: 'Released',  value: released }                                                   : null,
            publishers.length ? { label: 'Publisher', value: publishers.join(', ') }                                      : null,
            developers.length ? { label: 'Developer', value: developers.join(', ') }                                      : null,
            ig.platforms && ig.platforms.length ? { label: 'Platforms', value: ig.platforms.map(function(p) { return p.name; }).join(' / ') } : null
        ].filter(Boolean);

        var genreTagsHtml = (ig.genres || []).length
            ? '<div class="game-detail-genres">' + ig.genres.map(function(g) { return '<span class="game-detail-genre-tag">' + esc(g.name) + '</span>'; }).join('') + '</div>'
            : '';
        var infoGridHtml = infoItems.length
            ? '<div class="game-detail-info-grid">' + infoItems.map(function(i) { return '<div class="game-detail-info-item"><div class="game-detail-info-label">' + i.label + '</div><div class="game-detail-info-value">' + i.value + '</div></div>'; }).join('') + '</div>'
            : '';

        var scoreSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

        document.getElementById('clGameDetails').innerHTML =
            '<div class="game-detail-hero"><img src="' + coverUrl + '" alt="' + esc(ig.name) + ' banner" class="game-detail-hero-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'"></div>' +
            '<div class="game-detail-body">' +
                '<div class="game-detail-title-row">' +
                    '<img src="' + coverUrl + '" alt="' + esc(ig.name) + ' cover" class="game-detail-cover" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                    '<div class="game-detail-title-meta">' +
                        '<div class="game-detail-title">' + esc(ig.name) + '</div>' +
                        '<div class="game-detail-badges">' +
                            '<span class="game-detail-score" style="background:' + rc + ';">' + scoreSvg + ' ' + (score ? score + '/100' : 'No Rating') + '</span>' +
                            (released ? '<span class="game-detail-date">' + released + '</span>' : '') +
                        '</div>' +
                    '</div>' +
                '</div>' +
                genreTagsHtml + infoGridHtml +
                (ig.summary ? '<p class="game-detail-desc">' + esc(ig.summary) + '</p>' : '') +
            '</div>';

        upOpenModal('clGameModal');
    } catch (e) {
        console.error('Show CL game details error:', e);
    }
}

async function checkFollowStatus() {
    try {
        var r = await fetch(`${API_BASE}/follow/status/${viewingUserId}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) {
            followStatus = await r.json();
            updateFollowButton();
        }
    } catch (e) {
        console.error('Check follow status error:', e);
    }
}

function updateFollowButton() {
    var btn = document.getElementById('followActionBtn');
    if (followStatus.isFollowing) {
        btn.textContent = 'Following';
        btn.className   = 'btn btn-secondary btn-sm';
        btn.onclick     = unfollowUser;
    } else {
        btn.textContent = 'Follow';
        btn.className   = 'btn btn-success btn-sm';
        btn.onclick     = followUser;
    }
}

async function followUser() {
    try {
        var r = await fetch(`${API_BASE}/follow/${viewingUserId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) { await checkFollowStatus(); await loadUserProfile(); }
        else { var d = await r.json(); notify('Failed to follow: ' + (d.error || 'Unknown error')); }
    } catch (e) { notify('Error following user. Please try again.'); }
}

async function unfollowUser() {
    var ok = typeof confirmAction === 'function'
        ? await confirmAction({
            title: 'Unfollow user',
            message: 'Are you sure you want to unfollow this user?',
            confirmLabel: 'Unfollow',
            danger: true
          })
        : window.confirm('Are you sure you want to unfollow this user?');
    if (!ok) return;
    try {
        var r = await fetch(`${API_BASE}/follow/${viewingUserId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) { await checkFollowStatus(); await loadUserProfile(); }
        else { var d = await r.json(); notify('Failed to unfollow: ' + (d.error || 'Unknown error')); }
    } catch (e) { notify('Error unfollowing user. Please try again.'); }
}

function copyShareLink() {
    var url      = window.location.origin + '/userProfile.html?userId=' + viewingUserId;
    var feedback = document.getElementById('shareFeedback');
    var show     = function() {
        feedback.style.display = 'inline';
        setTimeout(function() { feedback.style.display = 'none'; }, 1800);
    };
    navigator.clipboard.writeText(url).then(show).catch(function() {
        var ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); show();
    });
}

var _upModalEscBound = false;
function upOpenModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    var focusable = el.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
    if (!_upModalEscBound) {
        _upModalEscBound = true;
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            document.querySelectorAll('.cl-modal-overlay.open, .cl-game-modal-overlay.open').forEach(function (m) {
                m.classList.remove('open');
            });
            document.body.style.overflow = '';
        });
    }
}
function upCloseModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
    document.body.style.overflow = '';
}

var _upToastTimer;
function upShowToast(msg, type) {
    type = type || '';
    var el = document.getElementById('clToast');
    el.textContent = msg;
    el.className   = 'cl-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(_upToastTimer);
    _upToastTimer = setTimeout(function() { el.classList.remove('show'); }, 3000);
}

function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
}

function logout() {
    if (typeof logoutToAuth === 'function') logoutToAuth();
    else {
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        window.location.href = 'auth.html';
    }
}
window.logout = logout;