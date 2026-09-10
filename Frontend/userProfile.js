const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '/api';

let authToken     = localStorage.getItem('authToken');
let currentUser   = (typeof getStoredUser === 'function') ? getStoredUser() : null;
let viewingUserId = null;
let followStatus  = { isFollowing: false, followsYou: false, requested: false, isPrivate: false };
let viewedUser    = null;

let userGamesCache      = [];
let currentSort         = 'recently_added';
let currentStatusFilter = 'all';
let currentMediaFilter  = 'all';
let currentSearchTerm   = '';

let upLists          = [];
let upListGames      = {};
let upExpandedListId = null;
let upFilters        = {};

var STATUS_LABEL = {
    playing:      'In progress',
    completed:    'Completed',
    plan_to_play: 'Planned',
    on_hold:      'On hold',
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

    // Category filter (Movies / Shows / Anime / Games / All)
    document.querySelectorAll('#upMediaTabs .media-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('#upMediaTabs .media-tab').forEach(function(t) { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
            tab.classList.add('active'); tab.setAttribute('aria-selected', 'true');
            currentMediaFilter = tab.dataset.media;
            displayUserGames(sortGames(userGamesCache));
            if (upLists.length) upRenderAccordion();
        });
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
}

async function loadUserProfile() {
    try {
        var r = await fetch(`${API_BASE}/users/${viewingUserId}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) {
            var d = await r.json();
            displayUserProfile(d.user);
            renderPersonal(d);
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
    viewedUser = user;
    var name = user.display_name || user.username;
    var avatarUrl = user.avatar_url ||
        'https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&size=200&background=475569&color=fff&bold=true';

    document.getElementById('profileTitle').textContent     = name + "'s profile";
    document.getElementById('gameListTitle').textContent    = name + "'s collection";
    document.getElementById('customListsTitle').textContent = name + "'s lists";
    document.getElementById('userAvatar').src               = avatarUrl;
    document.getElementById('displayName').textContent      = name;
    document.getElementById('displayUsername').textContent  = user.username;
    document.getElementById('displayCreatedAt').textContent = formatDate(user.created_at);
    document.getElementById('userLevel').textContent        = calculateLevel(user.totalGames || 0);
    document.getElementById('followersCount').textContent   = user.followersCount || 0;
    document.getElementById('followingCount').textContent   = user.followingCount || 0;

    // Category breakdown near the stats (matches your own profile).
    var bdEl = document.getElementById('upMediaBreakdown');
    if (bdEl) {
        if (user.canView) {
            var bd = user.mediaBreakdown || { movie: 0, series: 0, anime: 0, game: 0 };
            var order = [['movie', 'Movies'], ['series', 'Shows'], ['anime', 'Anime'], ['game', 'Games']];
            bdEl.hidden = false;
            bdEl.innerHTML = order.map(function (o) {
                return '<span class="cat-stat" data-cat="' + o[0] + '"><span class="cs-num">' + (bd[o[0]] || 0) + '</span><span class="cs-label">' + o[1] + '</span></span>';
            }).join('');
        } else { bdEl.hidden = true; bdEl.innerHTML = ''; }
    }

    // Privacy gate: hide the library/lists for a private account you don't follow.
    var notice = document.getElementById('privateNotice');
    var tabs   = document.getElementById('upTabs');
    var panels = document.querySelectorAll('.tab-panel');
    if (!user.canView) {
        if (notice) { notice.hidden = false; var pt = document.getElementById('privateNoticeText'); if (pt) pt.textContent = 'Follow ' + name + ' to see their library and lists. They’ll get a request to approve.'; }
        if (tabs) tabs.hidden = true;
        panels.forEach(function (p) { p.style.display = 'none'; });
    } else {
        if (notice) notice.hidden = true;
        if (tabs) tabs.hidden = false;
        panels.forEach(function (p) { p.style.display = ''; });
        if (!userGamesLoaded) { userGamesLoaded = true; loadUserGames(); }
    }
}
var userGamesLoaded = false;

async function loadUserGames() {
    if (typeof showSkeleton === 'function') showSkeleton('userGamesList', 'rows', 6);
    var container = document.getElementById('userGamesList');
    try {
        var r = await fetch(`${API_BASE}/users/${viewingUserId}/games`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) {
            var d = await r.json();
            userGamesCache = d.games || [];
            updateUpMediaCounts();
            displayUserGames(sortGames(userGamesCache));
        } else {
            // Never leave the skeleton spinning - always resolve to a real state.
            var msg = r.status === 403 ? 'This collection is private.' : 'Could not load this collection.';
            if (container) container.innerHTML = '<div class="coll-empty-state"><div class="coll-empty-icon">' + msg + '</div><p>Please try again in a moment.</p></div>';
        }
    } catch (e) {
        console.error('Load user games error:', e);
        if (container) container.innerHTML = '<div class="coll-empty-state"><div class="coll-empty-icon">Could not load this collection.</div><p>Check your connection and try again.</p></div>';
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

function updateUpMediaCounts() {
    var counts = { all: userGamesCache.length, movie: 0, series: 0, anime: 0, game: 0 };
    userGamesCache.forEach(function (g) { var t = g.media_type || 'game'; if (counts[t] != null) counts[t]++; });
    document.querySelectorAll('#upMediaTabs .media-tab').forEach(function (tab) {
        var k = tab.dataset.media;
        if (tab.querySelector('.mt-count')) tab.querySelector('.mt-count').textContent = counts[k] || 0;
        else {
            tab.appendChild(document.createTextNode(' '));
            var countSpan = document.createElement('span');
            countSpan.className = 'mt-count';
            countSpan.textContent = counts[k] || 0;
            tab.appendChild(countSpan);
        }
    });
}

function displayUserGames(games) {
    var container = document.getElementById('userGamesList');
    var filtered  = games;

    if (currentMediaFilter !== 'all') {
        filtered = filtered.filter(function(g) { return (g.media_type || 'game') === currentMediaFilter; });
    }
    if (currentStatusFilter !== 'all') {
        filtered = filtered.filter(function(g) { return g.status === currentStatusFilter; });
    }
    if (currentSearchTerm) {
        filtered = filtered.filter(function(g) { return (g.name || '').toLowerCase().includes(currentSearchTerm); });
    }

    if (filtered.length === 0) {
        var escFn = typeof esc === 'function' ? esc : function (s) { return String(s || ''); };
        var term = escFn(currentSearchTerm);
        var statusLbl = escFn(STATUS_LABEL[currentStatusFilter] || currentStatusFilter);
        var msg = 'Nothing here yet.';
        if (currentSearchTerm) msg = 'No titles matching "' + term + '".';
        else if (currentStatusFilter !== 'all') msg = 'No titles marked "' + statusLbl + '".';
        else if (currentMediaFilter !== 'all') msg = 'No ' + (typeof mediaTypeLabel === 'function' ? mediaTypeLabel(currentMediaFilter, true).toLowerCase() : currentMediaFilter) + ' tracked.';
        container.innerHTML = '<div class="coll-empty-state"><div class="coll-empty-icon">No titles found</div><p>' + msg + '</p></div>';
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
                (game.notes ? '<div class="coll-note" title="Review or note">' + esc(game.notes) + '</div>' : '') +
            '</div>' +
            '<div class="coll-item-right">' +
                '<div class="coll-score-badge">' + (game.score ? game.score : '-') + '</div>' +
            '</div>' +
        '</div>' +
    '</div>';
}

/* A title on someone's profile opens its own page, the same as everywhere
   else, instead of a popup over their list. From there the visitor can add it
   to their own library. */
function showGameDetails(gameId) {
    if (gameId) window.location.href = 'title.html?ref=' + encodeURIComponent(gameId);
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
    var visible = (currentMediaFilter === 'all')
        ? upLists
        : upLists.filter(function (l) { return l.category === currentMediaFilter; });
    if (upLists.length === 0) {
        container.innerHTML = '<div class="coll-empty-state"><div class="coll-empty-icon">No lists</div><p>This user has no public lists yet.</p></div>';
        return;
    }
    if (visible.length === 0) {
        var lbl = UP_CAT_LABEL[currentMediaFilter] || currentMediaFilter;
        container.innerHTML = '<div class="coll-empty-state"><div class="coll-empty-icon">No ' + esc(lbl) + ' lists</div><p>Switch to All to see their other lists.</p></div>';
        return;
    }
    container.innerHTML = visible.map(function(list) { return upRenderAccordionRow(list); }).join('');

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

var UP_CAT_LABEL = { movie: 'Movies', series: 'Shows', anime: 'Anime', game: 'Games' };
function upRenderAccordionRow(list) {
    var count      = list.game_count || 0;
    var isExpanded = upExpandedListId === list.id;
    var catBadge   = list.category ? '<span class="cl-cat-badge" data-cat="' + list.category + '">' + UP_CAT_LABEL[list.category] + '</span>' : '';
    return '<div class="cl-acc-row ' + (isExpanded ? 'expanded' : '') + '" data-list-id="' + list.id + '">' +
        '<div class="up-acc-header cl-acc-header">' +
            '<div class="cl-acc-header-left">' +
                '<span class="cl-acc-chevron">' + (isExpanded ? 'v' : '>') + '</span>' +
                '<div class="cl-acc-title-group">' +
                    '<div class="cl-acc-title-row">' +
                        '<span class="cl-acc-name">' + esc(list.name) + '</span>' +
                        catBadge +
                        '<span class="pill">' + count + ' ' + (count === 1 ? 'title' : 'titles') + '</span>' +
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
        return '<button class="status-tab ' + (f.status === s ? 'active' : '') + '" data-status="' + s + '">' + (s === 'all' ? 'All' : STATUS_LABEL[s]) + '</button>';
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
                (g.note ? '<div class="coll-note" title="Review or note">' + esc(g.note) + '</div>' : '') +
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
    if (!btn) return;
    if (viewedUser && viewedUser.isSelf) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    if (followStatus.isFollowing) {
        btn.textContent = 'Following'; btn.className = 'btn btn-secondary btn-sm'; btn.onclick = unfollowUser;
    } else if (followStatus.requested) {
        btn.textContent = 'Requested'; btn.className = 'btn btn-secondary btn-sm'; btn.onclick = unfollowUser;
    } else {
        btn.textContent = followStatus.isPrivate ? 'Request to follow' : 'Follow';
        btn.className = 'btn btn-primary btn-sm'; btn.onclick = followUser;
    }
}

async function followUser() {
    try {
        var r = await fetch(`${API_BASE}/follow/${viewingUserId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        var d = await r.json().catch(function () { return {}; });
        if (r.ok) {
            if (d.status === 'requested' && typeof toast === 'function') toast('Follow request sent.', 'success');
            userGamesLoaded = false;
            await loadUserProfile();
        } else { notify('Failed to follow: ' + (d.error || 'Unknown error')); }
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
        if (r.ok) { userGamesLoaded = false; await loadUserProfile(); }
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

/* ── Personal profile sections ─────────────────────────────────────────────
   Currently into, the Top 10s, Similar Taste, and people who match. All of it is
   derived from the library, so a private account you do not follow gets none of
   it: the API sends nulls and every section below stays hidden. */

var PF_PAGE_FOR = { movie: 'movies.html', series: 'series.html', anime: 'anime.html', game: 'home.html' };
var PF_LABEL    = { movie: 'Movies', series: 'Shows', anime: 'Anime', game: 'Games' };
var PF_ORDER    = ['movie', 'series', 'anime', 'game'];
var PF_FALLBACK_IMG = '/img/no-image.svg';
var pfTop = null;
var pfActiveTopCat = null;

function pfEsc(v) {
    return (typeof esc === 'function') ? esc(v) : String(v == null ? '' : v);
}

function pfOpenHref(mediaType, ref) {
    // Straight to the title's own page rather than a browse grid that bounces there.
    return 'title.html?ref=' + encodeURIComponent(ref);
}

function pfPoster(src, alt) {
    var url = src || PF_FALLBACK_IMG;
    return '<img src="' + pfEsc(url) + '" alt="' + pfEsc(alt || '') + '" loading="lazy" data-fallback="1">';
}

// One delegated handler rather than an inline onerror on every poster, which
// keeps the markup free of script and works under the page's CSP.
document.addEventListener('error', function (e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.dataset.fallback === '1' && img.src.indexOf(PF_FALLBACK_IMG) === -1) {
        img.dataset.fallback = '0';
        img.src = PF_FALLBACK_IMG;
    }
}, true);

function renderPersonal(payload) {
    var user = payload.user || {};
    // The accent tints this profile's headings and rank numbers, so a page reads
    // as someone's own without leaving the app's four category colors.
    var section = document.getElementById('upProfileSection');
    if (section) section.setAttribute('data-accent', user.accent || 'movie');

    renderBio(user.bio);
    renderSimilarBadge(payload.similarity, user);
    renderCurrentlyInto(payload.currentlyInto);
    renderTopTen(payload.top);
    renderBanner(user, payload.top, payload.currentlyInto);
    if (user.canView && !user.isSelf) loadSimilarPeople();
}

function renderBio(bio) {
    var el = document.getElementById('upBio');
    if (!el) return;
    if (!bio) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = bio;
}

/* The header is filled with poster art the profile already has rather than a
   second uploaded image. Nothing extra to store, and it always looks like the
   person it belongs to. Below four posters it stays a plain accent wash, since a
   sparse strip looks broken rather than deliberate. */
function renderBanner(user, top, current) {
    var el = document.getElementById('upBanner');
    if (!el) return;
    if (user.banner_style === 'accent' || !user.canView) { el.className = 'pf-banner'; el.innerHTML = ''; return; }

    var posters = [];
    PF_ORDER.forEach(function (cat) {
        ((top && top[cat]) || []).forEach(function (it) { if (it.background_image) posters.push(it.background_image); });
    });
    ((current && current.items) || []).forEach(function (it) { if (it.background_image) posters.push(it.background_image); });

    var unique = [];
    posters.forEach(function (src) { if (unique.indexOf(src) === -1) unique.push(src); });
    if (unique.length < 4) { el.className = 'pf-banner'; el.innerHTML = ''; return; }

    el.className = 'pf-banner has-art';
    el.innerHTML = unique.slice(0, 12).map(function (src) { return pfPoster(src, ''); }).join('');
}

function renderSimilarBadge(similarity, user) {
    var el = document.getElementById('upSimilar');
    if (!el) return;
    if (user.isSelf || !user.canView) { el.hidden = true; el.innerHTML = ''; return; }

    el.hidden = false;
    if (!similarity) {
        // Deliberately not a number. Too little between you for one to mean anything.
        el.innerHTML = '<span class="pf-similar-none">Not enough data yet</span>' +
            '<span class="pf-similar-note">Rate and rank a few more titles to compare taste.</span>';
        return;
    }
    var bits = [];
    if (similarity.shared) bits.push(similarity.shared + ' in common');
    if (similarity.coRated) bits.push(similarity.coRated + ' both rated');
    if (similarity.topShared) bits.push(similarity.topShared + ' shared Top 10');
    el.innerHTML =
        '<span class="pf-similar-pct">' + Number(similarity.percent) + '%</span>' +
        '<span class="pf-similar-label">Similar taste</span>' +
        '<button type="button" class="link-btn pf-similar-more" id="upCompareBtn">Compare in detail</button>' +
        (bits.length ? '<span class="pf-similar-note">' + pfEsc(bits.join(' · ')) + '</span>' : '');
    wireCompareButton();
}

function renderCurrentlyInto(current) {
    var wrap = document.getElementById('upCurrent');
    var list = document.getElementById('upCurrentList');
    if (!wrap || !list) return;
    var items = (current && current.items) || [];
    if (!items.length) { wrap.hidden = true; list.innerHTML = ''; return; }

    wrap.hidden = false;
    list.innerHTML = items.map(function (it) {
        var verb = it.media_type === 'game' ? 'Playing' : 'Watching';
        var prog = '';
        if (it.episode_count && it.progress != null) {
            prog = '<span class="pf-current-prog">Episode ' + Number(it.progress) + ' of ' + Number(it.episode_count) + '</span>';
        }
        return '<a class="pf-current-item" data-cat="' + pfEsc(it.media_type) + '" href="' + pfEsc(pfOpenHref(it.media_type, it.game_id)) + '">' +
            pfPoster(it.background_image, '') +
            '<span class="pf-current-body">' +
                '<span class="pf-current-verb">' + verb + '</span>' +
                '<span class="pf-current-name">' + pfEsc(it.name) + '</span>' +
                prog +
            '</span>' +
        '</a>';
    }).join('');
}

function renderTopTen(top) {
    var wrap = document.getElementById('upTop');
    var tabs = document.getElementById('upTopTabs');
    var list = document.getElementById('upTopList');
    if (!wrap || !tabs || !list) return;
    pfTop = top || null;

    var filled = PF_ORDER.filter(function (c) { return pfTop && pfTop[c] && pfTop[c].length; });
    if (!filled.length) { wrap.hidden = true; return; }

    wrap.hidden = false;
    if (!pfActiveTopCat || filled.indexOf(pfActiveTopCat) === -1) pfActiveTopCat = filled[0];

    // Only worth a category switcher when there is more than one list to switch to.
    tabs.hidden = filled.length < 2;
    tabs.innerHTML = filled.length < 2 ? '' : filled.map(function (cat) {
        var on = cat === pfActiveTopCat;
        return '<button type="button" role="tab" class="pf-chip' + (on ? ' active' : '') + '" data-cat="' + cat + '"' +
            ' aria-selected="' + on + '">' + PF_LABEL[cat] + '</button>';
    }).join('');
    tabs.querySelectorAll('.pf-chip').forEach(function (b) {
        b.addEventListener('click', function () { pfActiveTopCat = b.dataset.cat; renderTopTen(pfTop); });
    });

    list.setAttribute('data-cat', pfActiveTopCat);
    var items = pfTop[pfActiveTopCat] || [];
    list.innerHTML = items.map(function (it) {
        return '<li class="pf-top-item">' +
            '<a href="' + pfEsc(pfOpenHref(pfActiveTopCat, it.game_id)) + '" title="' + pfEsc(it.name) + '">' +
                '<span class="pf-top-rank">' + Number(it.position) + '</span>' +
                pfPoster(it.background_image, it.name) +
                '<span class="pf-top-name">' + pfEsc(it.name) + '</span>' +
            '</a>' +
        '</li>';
    }).join('');
}

async function loadSimilarPeople() {
    var wrap = document.getElementById('upSimilarPeople');
    var list = document.getElementById('upSimilarPeopleList');
    if (!wrap || !list) return;
    try {
        var r = await fetch(API_BASE + '/discover/similar?limit=6', {
            headers: { Authorization: 'Bearer ' + authToken }
        });
        if (!r.ok) return;
        var d = await r.json();
        // The person whose page this is does not belong in their own suggestions.
        var people = (d.users || []).filter(function (u) { return String(u.id) !== String(viewingUserId); });
        if (!people.length) return;

        wrap.hidden = false;
        list.innerHTML = people.map(function (u) {
            var name = u.display_name || u.username;
            var avatar = u.avatar_url ||
                'https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&size=96&background=475569&color=fff&bold=true';
            return '<a class="pf-person" href="userProfile.html?userId=' + encodeURIComponent(u.id) + '">' +
                '<img src="' + pfEsc(avatar) + '" alt="" loading="lazy">' +
                '<span class="pf-person-name">' + pfEsc(name) + '</span>' +
                '<span class="pf-person-pct">' + Number(u.similarity.percent) + '%</span>' +
            '</a>';
        }).join('');
    } catch (_) { /* discovery is a bonus: if it fails the section simply stays off */ }
}

/* ── Compare profiles ──────────────────────────────────────────────────────
   The headline percentage says how alike two people are. This says where: the
   titles you both rate highly, the ones you disagree most about, what you both
   ranked, and the same score per category, since matching on films says nothing
   about games. Fetched only when asked for, because most visits never open it. */

var pfCompareLoaded = false;

function wireCompareButton() {
    var btn = document.getElementById('upCompareBtn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', function () {
        var section = document.getElementById('upCompare');
        if (!section) return;
        if (pfCompareLoaded) {
            section.hidden = !section.hidden;
            btn.textContent = section.hidden ? 'Compare in detail' : 'Hide comparison';
            if (!section.hidden) section.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
        }
        loadCompare();
    });
}

async function loadCompare() {
    var section = document.getElementById('upCompare');
    var body = document.getElementById('upCompareBody');
    var btn = document.getElementById('upCompareBtn');
    if (!section || !body) return;

    section.hidden = false;
    body.innerHTML = '<p class="pf-empty">Working it out...</p>';
    if (btn) { btn.disabled = true; btn.textContent = 'Comparing...'; }

    try {
        var r = await fetch(API_BASE + '/users/' + encodeURIComponent(viewingUserId) + '/compare', {
            headers: { Authorization: 'Bearer ' + authToken }
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) {
            body.innerHTML = '<p class="pf-empty">' + pfEsc(d.error || 'Could not compare right now.') + '</p>';
        } else {
            renderCompare(d);
            pfCompareLoaded = true;
        }
    } catch (_) {
        body.innerHTML = '<p class="pf-empty">Could not reach the server.</p>';
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Hide comparison'; }
}

function compareTitleRow(item, right) {
    var href = pfOpenHref(item.media_type, item.media_ref);
    return '<a class="pf-cmp-row" href="' + pfEsc(href) + '" data-cat="' + pfEsc(item.media_type) + '">' +
        pfPoster(item.background_image, '') +
        '<span class="pf-cmp-name">' + pfEsc(item.name) + '</span>' +
        right +
    '</a>';
}

function renderCompare(d) {
    var body = document.getElementById('upCompareBody');
    var them = (d.user && (d.user.display_name || d.user.username)) || 'them';
    var parts = [];

    // Per category. A category with too little behind it says so rather than
    // showing a number, exactly like the headline figure does.
    var cats = [['movie', 'Movies'], ['series', 'Shows'], ['anime', 'Anime'], ['game', 'Games']];
    var catRows = cats.map(function (c) {
        var s = (d.categories || {})[c[0]] || {};
        var pct = s.percent;
        var bar = pct == null
            ? '<span class="pf-cmp-bar"><span style="width:0"></span></span>'
            : '<span class="pf-cmp-bar"><span style="width:' + Number(pct) + '%"></span></span>';
        var value = pct == null
            ? '<span class="pf-cmp-nodata">Not enough shared</span>'
            : '<span class="pf-cmp-pct">' + Number(pct) + '%</span>';
        return '<div class="pf-cmp-cat" data-cat="' + c[0] + '">' +
            '<span class="pf-cmp-cat-name">' + c[1] + '</span>' + bar + value +
        '</div>';
    }).join('');
    parts.push('<div class="pf-cmp-cats">' + catRows + '</div>');

    var counts = d.counts || {};
    parts.push('<p class="pf-hint pf-cmp-counts">' +
        Number(counts.shared || 0) + ' titles in both libraries, ' +
        Number(counts.coRated || 0) + ' rated by both of you.</p>');

    if ((d.commonTop || []).length) {
        parts.push('<h3 class="pf-cmp-h">Both of you ranked these</h3>');
        parts.push('<div class="pf-cmp-list">' + d.commonTop.map(function (it) {
            return compareTitleRow(it, '<span class="pf-cmp-ranks">' +
                '<span title="Your rank">#' + Number(it.yourPosition) + '</span>' +
                '<span class="pf-cmp-vs">vs</span>' +
                '<span title="Their rank">#' + Number(it.theirPosition) + '</span>' +
            '</span>');
        }).join('') + '</div>');
    }

    if ((d.favourites || []).length) {
        parts.push('<h3 class="pf-cmp-h">You both rate these highly</h3>');
        parts.push('<div class="pf-cmp-list">' + d.favourites.map(function (it) {
            return compareTitleRow(it, '<span class="pf-cmp-scores">' +
                '<span class="pf-cmp-you">' + Number(it.yourScore) + '</span>' +
                '<span class="pf-cmp-vs">vs</span>' +
                '<span class="pf-cmp-them">' + Number(it.theirScore) + '</span>' +
            '</span>');
        }).join('') + '</div>');
    }

    if ((d.disagreements || []).length) {
        parts.push('<h3 class="pf-cmp-h">You disagree most about these</h3>');
        parts.push('<div class="pf-cmp-list">' + d.disagreements.map(function (it) {
            return compareTitleRow(it, '<span class="pf-cmp-scores is-apart">' +
                '<span class="pf-cmp-you">' + Number(it.yourScore) + '</span>' +
                '<span class="pf-cmp-vs">vs</span>' +
                '<span class="pf-cmp-them">' + Number(it.theirScore) + '</span>' +
            '</span>');
        }).join('') + '</div>');
    }

    if (!(d.commonTop || []).length && !(d.favourites || []).length && !(d.disagreements || []).length) {
        parts.push('<p class="pf-empty">Nothing you have both rated yet. Score a few of the titles you share with ' +
            pfEsc(them) + ' and this fills in.</p>');
    }

    body.innerHTML = parts.join('');
}
