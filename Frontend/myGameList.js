const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '/api';

let authToken   = localStorage.getItem('authToken');
let currentUser = (typeof getStoredUser === 'function') ? getStoredUser() : null;

let myGamesCache          = [];
let currentMyGamesSort    = 'recently_added';
let currentStatusFilter   = 'all';
let currentMediaFilter    = 'all';
let currentSearchTerm     = '';
let isEditMode            = false;
let currentUpdateGameId   = null;
let currentRemoveGameId   = null;
let currentRemoveGameName = null;

let clLists          = [];
let clListGames      = {};
let clEditingId      = null;
let clRemoveGameId   = null;
let clExpandedListId = null;
let clIsEditMode     = {};
let clFilters        = {};
let _clPendingDeleteId = null;
let _updateScoreBound = false;

(async function bootMyList() {
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
        var response = await fetch(`${API_BASE}/auth/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (response.ok) {
            var data = await response.json();
            currentUser = data.user;
            localStorage.setItem('currentUser', JSON.stringify(data.user));
            initPage();
        } else if (response.status === 401 || response.status === 403) {
            logout();
        } else if (currentUser) {
            initPage();
        }
    } catch (error) {
        console.error('Verify token error:', error);
        if (currentUser) initPage();
    }
}

function initPage() {
    initPageTabs();
    initCollectionTab();
    initCustomListsTab();
}

function initPageTabs() {
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
            if (tab.dataset.tab === 'lists' && clLists.length === 0) {
                clLoadLists();
            }
        });
    });
}

function initCollectionTab() {
    document.querySelectorAll('.status-tab:not(.cl-status-tab)').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.status-tab:not(.cl-status-tab)').forEach(function(t) { t.classList.remove('active'); });
            tab.classList.add('active');
            currentStatusFilter = tab.dataset.status;
            displayMyGames(sortMyGames(myGamesCache));
        });
    });

    // Category tabs: All / Games / Movies / Series.
    document.querySelectorAll('.media-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.media-tab').forEach(function(t) {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            currentMediaFilter = tab.dataset.media;
            // Recolor the whole page accent to the selected category.
            document.body.setAttribute('data-page', MEDIA_PAGE_KEY[currentMediaFilter] || 'list');
            updateStatistics(filterByMedia(myGamesCache));
            displayMyGames(sortMyGames(myGamesCache));
            // The category row is shared, so keep the Custom Lists view in sync too.
            if (clExpandedListId && typeof clRenderAccGames === 'function') {
                clRenderAccGames(clExpandedListId);
            }
        });
    });

    // Grid / list view toggle (persisted per device).
    var viewBtn = document.getElementById('viewToggleBtn');
    var gridEl = document.getElementById('myGamesGrid');
    function applyView(mode) {
        var isGrid = mode === 'grid';
        if (gridEl) gridEl.classList.toggle('as-grid', isGrid);
        if (viewBtn) { viewBtn.textContent = isGrid ? 'List' : 'Grid'; viewBtn.setAttribute('aria-pressed', isGrid ? 'true' : 'false'); }
    }
    var savedView = 'list';
    try { if (localStorage.getItem('libraryView') === 'grid') savedView = 'grid'; } catch (_) {}
    applyView(savedView);
    if (viewBtn) {
        viewBtn.addEventListener('click', function() {
            var next = (gridEl && gridEl.classList.contains('as-grid')) ? 'list' : 'grid';
            applyView(next);
            try { localStorage.setItem('libraryView', next); } catch (_) {}
        });
    }

    document.getElementById('editListBtn').addEventListener('click', function() { toggleEditMode(true); });
    document.getElementById('doneEditingBtn').addEventListener('click', function() { toggleEditMode(false); });

    if (typeof bindModal === 'function') {
        bindModal('gameModal', 'closeModalBtn');
        bindModal('updateModal');
        bindModal('removeModal');
    } else {
        document.getElementById('closeModalBtn').addEventListener('click', function() {
            document.getElementById('gameModal').style.display = 'none';
        });
    }
    document.getElementById('confirmUpdateBtn').addEventListener('click', confirmUpdate);
    document.getElementById('cancelUpdateBtn').addEventListener('click', closeUpdateModal);
    document.getElementById('confirmRemoveBtn').addEventListener('click', confirmRemove);
    document.getElementById('cancelRemoveBtn').addEventListener('click', closeRemoveModal);

    var myGamesSortSelect = document.getElementById('myGamesSort');
    myGamesSortSelect.value = 'recently_added';
    myGamesSortSelect.addEventListener('change', function() {
        currentMyGamesSort = myGamesSortSelect.value;
        displayMyGames(sortMyGames(myGamesCache));
    });

    var searchInput = document.getElementById('myGamesSearch');
    if (searchInput) {
        searchInput.addEventListener('input', function(e) {
            currentSearchTerm = e.target.value.toLowerCase().trim();
            displayMyGames(sortMyGames(myGamesCache));
        });
    }

    if (typeof bindActivatableCards === 'function') {
        bindActivatableCards(document, '.coll-item.list-item', function(row) {
            if (row.dataset.gameId) showGameDetails(row.dataset.gameId);
        });
    }

    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('coll-ep-plus')) {
            e.stopPropagation();
            incrementEpisode(e.target.dataset.gameId);
            return;
        }
        if (e.target.classList.contains('update-btn')) {
            showUpdateModal(e.target.dataset.gameId);
        } else if (e.target.classList.contains('delete-btn')) {
            showRemoveModal(e.target.dataset.gameId, e.target.dataset.gameName);
        }
    });

    loadMyGames();
}

async function loadMyGames() {
    try {
        var response = await fetch(`${API_BASE}/user/games`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        var data = await response.json();
        if (response.ok) {
            myGamesCache = data.games;
            updateMediaTabCounts();
            updateStatistics(filterByMedia(data.games));
            displayMyGames(sortMyGames(data.games));
        } else {
            showError(document.getElementById('myGamesGrid'), 'Failed to fetch games. Please try again.');
        }
    } catch (error) {
        console.error('Load my games error:', error);
        showError(document.getElementById('myGamesGrid'), 'Network error. Please try again.');
    }
}

var MEDIA_PAGE_KEY = { all: 'list', movie: 'movies', series: 'series', anime: 'anime', game: 'games' };
var MEDIA_TAB_LABEL = { all: 'All', movie: 'Movies', series: 'Shows', anime: 'Anime', game: 'Games' };

// Populate the per-category count badges on the collection tabs.
function updateMediaTabCounts() {
    var games = myGamesCache || [];
    var counts = { all: games.length, movie: 0, series: 0, anime: 0, game: 0 };
    games.forEach(function(g) {
        var t = g.media_type || 'game';
        if (counts[t] != null) counts[t]++;
    });
    document.querySelectorAll('.media-tab').forEach(function(tab) {
        var m = tab.dataset.media;
        tab.innerHTML = (MEDIA_TAB_LABEL[m] || m) +
            ' <span class="mt-count">' + (counts[m] || 0) + '</span>';
    });
}

function updateStatistics(games) {
    var stats = {
        total:        games.length,
        playing:      games.filter(function(g) { return g.status === 'playing'; }).length,
        completed:    games.filter(function(g) { return g.status === 'completed'; }).length,
        plan_to_play: games.filter(function(g) { return g.status === 'plan_to_play'; }).length,
        on_hold:      games.filter(function(g) { return g.status === 'on_hold'; }).length,
        dropped:      games.filter(function(g) { return g.status === 'dropped'; }).length
    };
    var pct = function(k) { return stats.total > 0 ? (stats[k] / stats.total * 100).toFixed(1) : 0; };
    updateBarChart({
        playing:      pct('playing'),
        completed:    pct('completed'),
        plan_to_play: pct('plan_to_play'),
        on_hold:      pct('on_hold'),
        dropped:      pct('dropped')
    }, stats);

    // Pie + legend: on "All" show how the library splits across the four
    // categories (each treated individually); inside a category show its
    // own status breakdown.
    var segments;
    if (currentMediaFilter === 'all') {
        var all = myGamesCache || [];
        segments = CAT_META.map(function(c) {
            return { label: c.label, color: c.color,
                count: all.filter(function(g) { return (g.media_type || 'game') === c.key; }).length };
        });
    } else {
        segments = STATUS_META.map(function(s) {
            return { label: s.label, color: s.color, count: stats[s.key] };
        });
    }
    drawPie(segments);
    drawPieLegend(segments);

    var titleEl = document.querySelector('.stats-title');
    if (titleEl) {
        titleEl.textContent = currentMediaFilter === 'all'
            ? 'Your library at a glance'
            : MEDIA_TAB_LABEL[currentMediaFilter] + ' status breakdown';
    }
}

var CAT_META = [
    { key: 'movie',  label: 'Movies', color: '#60a5fa' },
    { key: 'series', label: 'Shows',  color: '#34d399' },
    { key: 'anime',  label: 'Anime',  color: '#f472b6' },
    { key: 'game',   label: 'Games',  color: '#fbbf24' }
];
var STATUS_META = [
    { key: 'playing',      label: 'Watching / Playing', color: '#3498db' },
    { key: 'completed',    label: 'Completed',          color: '#2ecc71' },
    { key: 'plan_to_play', label: 'Planned',            color: '#9b59b6' },
    { key: 'on_hold',      label: 'On Hold',            color: '#f39c12' },
    { key: 'dropped',      label: 'Dropped',            color: '#e74c3c' }
];

function updateBarChart(percentages, stats) {
    [
        { id: 'playingBar',   pct: 'playingPercent',   val: percentages.playing,      cnt: stats.playing },
        { id: 'completedBar', pct: 'completedPercent', val: percentages.completed,    cnt: stats.completed },
        { id: 'planBar',      pct: 'planPercent',      val: percentages.plan_to_play, cnt: stats.plan_to_play },
        { id: 'onholdBar',    pct: 'onholdPercent',    val: percentages.on_hold,      cnt: stats.on_hold },
        { id: 'droppedBar',   pct: 'droppedPercent',   val: percentages.dropped,      cnt: stats.dropped }
    ].forEach(function(b) {
        var barEl = document.getElementById(b.id);
        var pctEl = document.getElementById(b.pct);
        if (barEl && pctEl) {
            setTimeout(function() { barEl.style.width = b.val + '%'; }, 100);
            pctEl.textContent = b.val + '% (' + b.cnt + ')';
        }
    });
}

function drawPie(segments) {
    var svg = document.getElementById('pieChartSvg');
    if (!svg) return;
    var total = segments.reduce(function(s, x) { return s + x.count; }, 0);
    if (total === 0) {
        svg.innerHTML = '<circle cx="100" cy="100" r="90" fill="#1e2a38" />';
        return;
    }
    var active = segments.filter(function(s) { return s.count > 0; });
    // A single non-zero slice is a full circle; a 360-degree arc renders as
    // nothing, so draw an actual circle instead.
    if (active.length === 1) {
        svg.innerHTML = '<circle cx="100" cy="100" r="90" fill="' + active[0].color + '" />';
        return;
    }
    var cur = -90, cx = 100, cy = 100, r = 90, paths = '';
    active.forEach(function(s) {
        var angle = (s.count / total) * 360;
        var sa = cur * Math.PI / 180, ea = (cur + angle) * Math.PI / 180;
        var x1 = cx + r * Math.cos(sa), y1 = cy + r * Math.sin(sa);
        var x2 = cx + r * Math.cos(ea), y2 = cy + r * Math.sin(ea);
        paths += '<path d="M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + (angle > 180 ? 1 : 0) + ' 1 ' + x2 + ' ' + y2 + ' Z" fill="' + s.color + '" />';
        cur += angle;
    });
    svg.innerHTML = paths;
}

function drawPieLegend(segments) {
    var el = document.getElementById('pieLegend');
    if (!el) return;
    var total = segments.reduce(function(s, x) { return s + x.count; }, 0);
    el.innerHTML = segments.map(function(s) {
        var pctNum = total > 0 ? Math.round(s.count / total * 100) : 0;
        return '<div class="legend-item">' +
            '<span style="width:14px;height:14px;border-radius:4px;flex-shrink:0;background:' + s.color + ';"></span>' +
            '<span style="flex:1;color:var(--text-secondary);">' + s.label + '</span>' +
            '<span style="font-weight:700;color:var(--text-primary);">' + s.count + (total > 0 ? ' (' + pctNum + '%)' : '') + '</span>' +
            '</div>';
    }).join('');
}

function filterByMedia(games) {
    if (currentMediaFilter === 'all') return games;
    return games.filter(function(g) { return (g.media_type || 'game') === currentMediaFilter; });
}

function sortMyGames(games) {
    var sorted = games.slice();
    switch (currentMyGamesSort) {
        case 'recently_added': sorted.sort(function(a,b) { return a.created_at && b.created_at ? new Date(b.created_at)-new Date(a.created_at) : b.id-a.id; }); break;
        case 'name':           sorted.sort(function(a,b) { return a.name.localeCompare(b.name); }); break;
        case 'name_desc':      sorted.sort(function(a,b) { return b.name.localeCompare(a.name); }); break;
        case 'score_high':     sorted.sort(function(a,b) { return (b.score||0)-(a.score||0); }); break;
        case 'score_low':      sorted.sort(function(a,b) { return (a.score||0)-(b.score||0); }); break;
        case 'rating_high':    sorted.sort(function(a,b) { return (b.rating||0)-(a.rating||0); }); break;
        case 'rating_low':     sorted.sort(function(a,b) { return (a.rating||0)-(b.rating||0); }); break;
    }
    return sorted;
}

var STATUS_LABEL = { playing: 'In progress', completed: 'Completed', plan_to_play: 'Planned', on_hold: 'On hold', dropped: 'Dropped' };
var STATUS_COLOR = { playing: '#3498db', completed: '#2ecc71', plan_to_play: '#9b59b6', on_hold: '#f39c12', dropped: '#e74c3c' };

function getRatingColor(score) {
    if (!score)      return '#666';
    if (score >= 90) return '#10b981';
    if (score >= 75) return '#3b82f6';
    if (score >= 50) return '#f59e0b';
    return '#ef4444';
}

function displayMyGames(games) {
    var container = document.getElementById('myGamesGrid');
    var filtered  = filterByMedia(games);
    if (currentStatusFilter !== 'all') filtered = filtered.filter(function(g) { return g.status === currentStatusFilter; });
    if (currentSearchTerm) {
        filtered = filtered.filter(function(g) {
            return g.name.toLowerCase().includes(currentSearchTerm) ||
                (g.genres && g.genres.some(function(genre) { return (genre.name || genre).toLowerCase().includes(currentSearchTerm); }));
        });
    }
    if (filtered.length === 0) {
        if (!currentSearchTerm && currentStatusFilter === 'all') {
            var browseHref = currentMediaFilter === 'movie' ? 'movies.html'
                : currentMediaFilter === 'series' ? 'series.html'
                : currentMediaFilter === 'anime' ? 'anime.html' : 'home.html';
            var browseLabel = currentMediaFilter === 'movie' ? 'Browse movies'
                : currentMediaFilter === 'series' ? 'Browse shows'
                : currentMediaFilter === 'anime' ? 'Browse anime'
                : currentMediaFilter === 'game' ? 'Browse games' : 'Browse movies, shows, anime & games';
            container.innerHTML = '<div class="coll-empty-state">' +
                '<div class="coll-empty-icon">Your library is empty</div>' +
                '<p>Start building your library by browsing and adding the movies, shows, anime, and games you have enjoyed or want to explore.</p>' +
                '<a href="' + browseHref + '" class="btn btn-primary" style="margin-top:16px;">' + browseLabel + '</a>' +
                '</div>';
            return;
        }
        var escFn = typeof esc === 'function' ? esc : function (s) { return String(s || ''); };
        var term = escFn(currentSearchTerm);
        var statusLbl = escFn(STATUS_LABEL[currentStatusFilter] || currentStatusFilter);
        var noun = (typeof MEDIA_TAB_LABEL !== 'undefined' && currentMediaFilter !== 'all')
            ? MEDIA_TAB_LABEL[currentMediaFilter].toLowerCase() : 'titles';
        var msg = 'Nothing here yet.';
        if (currentSearchTerm && currentStatusFilter !== 'all')
            msg = 'No ' + noun + ' matching "' + term + '" with status "' + statusLbl + '".';
        else if (currentSearchTerm)
            msg = 'No ' + noun + ' matching "' + term + '".';
        else if (currentStatusFilter !== 'all')
            msg = 'No ' + noun + ' with status "' + statusLbl + '".';
        container.innerHTML = '<div class="coll-empty-state"><div class="coll-empty-icon">Nothing here</div><p>' + msg + '</p></div>';
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
    var progressHtml = '';
    if ((mediaType === 'series' || mediaType === 'anime') && game.episode_count) {
        var prog = game.progress || 0;
        var pct = Math.min(100, Math.round(prog / game.episode_count * 100));
        var done = prog >= game.episode_count;
        progressHtml = '<span class="coll-progress">' +
            '<span class="coll-progress-bar"><span class="coll-progress-fill" style="width:' + pct + '%"></span></span>' +
            '<span class="coll-progress-text">' + prog + ' / ' + game.episode_count + ' eps</span>' +
            (done ? '' : '<button type="button" class="coll-ep-plus" data-game-id="' + game.game_id + '" title="Watched one more episode" aria-label="Add one episode to ' + esc(game.name) + '">+1</button>') +
        '</span>';
    }

    var editActions = isEditMode
        ? '<div class="coll-item-edit-actions">' +
              '<button class="btn btn-secondary btn-sm update-btn" data-game-id="' + game.game_id + '">Edit</button>' +
              '<button class="btn btn-danger btn-sm delete-btn" data-game-id="' + game.game_id + '" data-game-name="' + esc(game.name) + '">Remove</button>' +
          '</div>'
        : '';

    return '<div class="coll-item list-item" data-game-id="' + game.game_id + '" role="button" tabindex="0" aria-label="' + esc('View details for ' + (game.name || 'title')) + '">' +
        '<img src="' + esc(imgSrc) + '" alt="' + esc(game.name || 'Cover') + '" class="coll-item-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
        '<div class="coll-item-body">' +
            '<div class="coll-item-main">' +
                '<div class="coll-item-name">' + esc(game.name) + '</div>' +
                '<div class="coll-item-meta">' +
                    '<span class="media-type-pill media-type-' + esc(mediaType) + '">' + esc(typeText) + '</span>' +
                    '<span class="status-dot-inline" style="background:' + statusColor + ';"></span>' +
                    '<span class="coll-item-status">' + esc(statusText) + '</span>' +
                    progressHtml +
                '</div>' +
            '</div>' +
            '<div class="coll-item-right">' +
                '<div class="coll-score-badge">' + (game.score ? game.score : '-') + '</div>' +
                editActions +
            '</div>' +
        '</div>' +
    '</div>';
}

// Build the detail info grid with labels appropriate to the media type.
function buildDetailInfoItems(game) {
    var mediaType = game.media_type || 'game';
    var names = function(list) { return (list || []).map(function(x) { return x.name || x; }).filter(Boolean); };
    var items = [];
    if (game.released) {
        items.push({ label: 'Released', value: new Date(game.released).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }) });
    }
    var devs = names(game.developers);
    var pubs = names(game.publishers);
    if (mediaType === 'movie') {
        if (devs.length) items.push({ label: 'Director', value: devs.join(', ') });
        if (pubs.length) items.push({ label: 'Studio', value: pubs.join(', ') });
    } else if (mediaType === 'series' || mediaType === 'anime') {
        if (devs.length) items.push({ label: mediaType === 'anime' ? 'Studio' : 'Creator', value: devs.join(', ') });
        if (pubs.length) items.push({ label: 'Network', value: pubs.join(', ') });
        if (game.episode_count) items.push({ label: 'Episodes', value: String(game.episode_count) });
    } else {
        if (pubs.length) items.push({ label: 'Publisher', value: pubs.join(', ') });
        if (devs.length) items.push({ label: 'Developer', value: devs.join(', ') });
        var plats = names(game.platforms);
        if (plats.length) items.push({ label: 'Platforms', value: plats.join(' · ') });
    }
    return items;
}

async function showGameDetails(gameId) {
    try {
        var response = await fetch(`${API_BASE}/games/${gameId}`);
        var game = await response.json();
        if (!response.ok) return;

        var heroBg = game.background_image || '/img/no-image.svg';
        var infoItems = buildDetailInfoItems(game);

        var genreTagsHtml = (game.genres || []).length
            ? '<div class="game-detail-genres">' + game.genres.map(function(g) { return '<span class="game-detail-genre-tag">' + esc(g.name || g) + '</span>'; }).join('') + '</div>'
            : '';

        var infoGridHtml = infoItems.length
            ? '<div class="game-detail-info-grid">' + infoItems.map(function(i) { return '<div class="game-detail-info-item"><div class="game-detail-info-label">' + esc(i.label) + '</div><div class="game-detail-info-value">' + esc(i.value) + '</div></div>'; }).join('') + '</div>'
            : '';

        var releasedBadge = game.released
            ? '<span class="game-detail-date">' + new Date(game.released).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }) + '</span>'
            : '';

        document.getElementById('gameDetails').innerHTML =
            '<div class="game-detail-hero">' +
                '<img src="' + heroBg + '" alt="' + esc(game.name) + ' banner" class="game-detail-hero-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
            '</div>' +
            '<div class="game-detail-body">' +
                '<div class="game-detail-title-row">' +
                    '<img src="' + heroBg + '" alt="' + esc(game.name) + ' cover" class="game-detail-cover" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                    '<div class="game-detail-title-meta">' +
                        '<div class="game-detail-title">' + esc(game.name) + '</div>' +
                        '<div class="game-detail-badges">' + releasedBadge + '</div>' +
                    '</div>' +
                '</div>' +
                genreTagsHtml +
                infoGridHtml +
                (game.description ? '<p class="game-detail-desc">' + game.description + '</p>' : '') +
            '</div>';
        var GCAT = { movie: 'movies', series: 'series', anime: 'anime', game: 'games' };
        var gmEl = document.getElementById('gameModal');
        if (gmEl) gmEl.setAttribute('data-cat', GCAT[game.media_type || 'game'] || 'games');
        if (typeof openModal === 'function') openModal('gameModal');
        else document.getElementById('gameModal').style.display = 'flex';
    } catch (error) {
        console.error('Show game details error:', error);
    }
}

function toggleEditMode(isEdit) {
    isEditMode = isEdit;
    document.getElementById('editListBtn').style.display    = isEdit ? 'none' : 'inline-block';
    document.getElementById('doneEditingBtn').style.display = isEdit ? 'inline-block' : 'none';
    displayMyGames(sortMyGames(myGamesCache));
}

function showUpdateModal(gameId) {
    currentUpdateGameId = gameId;
    var game = myGamesCache.find(function(g) { return g.game_id == gameId; });
    document.getElementById('updateStatus').value        = game ? game.status : 'completed';
    document.getElementById('updateScore').value         = game && game.score ? game.score : '';
    document.getElementById('updateGameName').textContent = game ? game.name : '';
    document.getElementById('updateMessage').innerHTML   = '';

    // Episode progress only applies to series/anime that have a known episode count.
    var mediaType = game ? (game.media_type || 'game') : 'game';
    // Theme the dialog to THIS item's category (green show, pink anime, …) rather
    // than inheriting the neutral My Library page accent.
    var CAT_OF = { movie: 'movies', series: 'series', anime: 'anime', game: 'games' };
    var umEl = document.getElementById('updateModal');
    if (umEl) umEl.setAttribute('data-cat', CAT_OF[mediaType] || 'games');
    var progRow = document.getElementById('updateProgressRow');
    var progInput = document.getElementById('updateProgress');
    var showProgress = game && (mediaType === 'series' || mediaType === 'anime') && game.episode_count;
    if (progRow) progRow.style.display = showProgress ? 'block' : 'none';
    if (progInput) {
        progInput.value = game && game.progress != null ? game.progress : '';
        if (showProgress) { progInput.max = game.episode_count; }
    }
    if (game) {
        var t = document.querySelector('#updateModal h3');
        if (t) t.textContent = 'Update ' + ((typeof mediaTypeLabel === 'function') ? mediaTypeLabel(mediaType) : 'item');
    }
    if (typeof openModal === 'function') openModal('updateModal');
    else document.getElementById('updateModal').style.display = 'flex';
    if (typeof bindScoreInput === 'function') {
        bindScoreInput('updateScore', 'updateScoreUpBtn', 'updateScoreDownBtn', 'updateScoreClearBtn');
    }
}

function closeUpdateModal() {
    if (typeof closeModal === 'function') closeModal('updateModal');
    else document.getElementById('updateModal').style.display = 'none';
    currentUpdateGameId = null;
}

// One-tap "watched one more episode" from the collection row. Auto-completes at
// the finale and keeps the stats/cards in sync without a reload.
async function incrementEpisode(gameId) {
    var game = (myGamesCache || []).find(function(g) { return String(g.game_id) === String(gameId); });
    if (!game || !game.episode_count) return;
    var cur = game.progress || 0;
    if (cur >= game.episode_count) return;
    var next = cur + 1;
    var status = game.status;
    if (next >= game.episode_count && status === 'playing') status = 'completed';
    try {
        var r = await fetch(`${API_BASE}/user/games/${gameId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ status: status, score: game.score || null, progress: next })
        });
        if (r.ok) {
            game.progress = next;
            game.status = status;
            updateMediaTabCounts();
            updateStatistics(filterByMedia(myGamesCache));
            displayMyGames(sortMyGames(myGamesCache));
            if (typeof toast === 'function') {
                toast(next >= game.episode_count ? '“' + game.name + '” completed!' : 'Marked episode ' + next + ' of “' + game.name + '”', 'success');
            }
        } else if (typeof toast === 'function') {
            toast('Could not update progress. Please try again.', 'error');
        }
    } catch (_) {
        if (typeof toast === 'function') toast('Network error. Please try again.', 'error');
    }
}

async function confirmUpdate() {
    var status = document.getElementById('updateStatus').value;
    var score  = document.getElementById('updateScore').value;
    var progRow = document.getElementById('updateProgressRow');
    var progInput = document.getElementById('updateProgress');
    var msgDiv = document.getElementById('updateMessage');
    if (score && (score < 1 || score > 10)) { showError(msgDiv, 'Score must be between 1 and 10'); return; }
    var body = { status: status, score: score ? parseInt(score) : null };
    if (progRow && progRow.style.display !== 'none' && progInput) {
        var pv = progInput.value;
        body.progress = pv === '' ? null : Math.max(0, parseInt(pv, 10) || 0);
    }
    try {
        var r = await fetch(`${API_BASE}/user/games/${currentUpdateGameId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify(body)
        });
        var d = await r.json();
        if (r.ok) {
            showSuccess(msgDiv, 'Game updated successfully!');
            setTimeout(function() { closeUpdateModal(); loadMyGames(); }, 1500);
        } else {
            showError(msgDiv, d.error || 'Failed to update game');
        }
    } catch (e) { showError(msgDiv, 'Network error. Please try again.'); }
}

function showRemoveModal(gameId, gameName) {
    currentRemoveGameId   = gameId;
    currentRemoveGameName = gameName;
    document.getElementById('removeGameText').textContent = 'Are you sure you want to remove "' + gameName + '" from your list?';
    document.getElementById('removeMessage').innerHTML    = '';
    if (typeof openModal === 'function') openModal('removeModal');
    else document.getElementById('removeModal').style.display = 'flex';
}

function closeRemoveModal() {
    if (typeof closeModal === 'function') closeModal('removeModal');
    else document.getElementById('removeModal').style.display = 'none';    currentRemoveGameId = currentRemoveGameName = null;
}

async function confirmRemove() {
    var msgDiv = document.getElementById('removeMessage');
    try {
        var r = await fetch(`${API_BASE}/user/games/${currentRemoveGameId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        var d = await r.json();
        if (r.ok) {
            showSuccess(msgDiv, '"' + currentRemoveGameName + '" removed!');
            setTimeout(function() { closeRemoveModal(); loadMyGames(); }, 1500);
        } else { showError(msgDiv, d.error || 'Failed to remove game'); }
    } catch (e) { showError(msgDiv, 'Network error. Please try again.'); }
}

function closeGameModal() {
    if (typeof closeModal === 'function') closeModal('gameModal');
    else document.getElementById('gameModal').style.display = 'none';
}

function initCustomListsTab() {
    document.getElementById('clNewListBtn').addEventListener('click', function() { clOpenListForm(null); });

    document.getElementById('clListFormClose').addEventListener('click', function() { clCloseModal('clListFormModal'); });
    document.getElementById('clListFormCancel').addEventListener('click', function() { clCloseModal('clListFormModal'); });
    document.getElementById('clListFormSubmit').addEventListener('click', clSubmitListForm);
    document.getElementById('clListFormModal').addEventListener('click', function(e) { if (e.target.id === 'clListFormModal') clCloseModal('clListFormModal'); });
    document.getElementById('clListName').addEventListener('input', function() { clUpdateCharCount('clListName', 'clListNameCount', 100); });
    document.getElementById('clListDesc').addEventListener('input', function() { clUpdateCharCount('clListDesc', 'clListDescCount', 500); });

    document.getElementById('clDeleteListClose').addEventListener('click',   function() { clCloseModal('clDeleteListModal'); });
    document.getElementById('clDeleteListCancel').addEventListener('click',  function() { clCloseModal('clDeleteListModal'); });
    document.getElementById('clDeleteListConfirm').addEventListener('click', clConfirmDeleteList);
    document.getElementById('clDeleteListModal').addEventListener('click',   function(e) { if (e.target.id === 'clDeleteListModal') clCloseModal('clDeleteListModal'); });

    document.getElementById('clRemoveGameClose').addEventListener('click',   function() { clCloseModal('clRemoveGameModal'); });
    document.getElementById('clRemoveGameCancel').addEventListener('click',  function() { clCloseModal('clRemoveGameModal'); });
    document.getElementById('clRemoveGameConfirm').addEventListener('click', clConfirmRemoveGame);
    document.getElementById('clRemoveGameModal').addEventListener('click',   function(e) { if (e.target.id === 'clRemoveGameModal') clCloseModal('clRemoveGameModal'); });

    document.getElementById('clEditGameCancel').addEventListener('click', function() { clCloseEditModal(); });
    document.getElementById('clEditGameSave').addEventListener('click',   clSaveEditGame);
    document.getElementById('clEditGameModal').addEventListener('click',  function(e) { if (e.target.id === 'clEditGameModal') clCloseEditModal(); });

    document.getElementById('clEditScoreUpBtn').addEventListener('click', function() {
        var inp = document.getElementById('clEditScoreInput');
        if (!inp.value) inp.value = 1; else if (parseInt(inp.value) < 10) inp.value = parseInt(inp.value) + 1;
    });
    document.getElementById('clEditScoreDownBtn').addEventListener('click', function() {
        var inp = document.getElementById('clEditScoreInput');
        if (!inp.value) inp.value = 1; else if (parseInt(inp.value) > 1) inp.value = parseInt(inp.value) - 1;
    });

    document.getElementById('clGameModal').addEventListener('click', function(e) { if (e.target.id === 'clGameModal') clCloseModal('clGameModal'); });
    document.getElementById('clGameModalClose').addEventListener('click', function() { clCloseModal('clGameModal'); });
}

function clOpenEditModal()  { document.getElementById('clEditGameModal').style.display = 'flex'; document.body.style.overflow = 'hidden'; }
function clCloseEditModal() { document.getElementById('clEditGameModal').style.display = 'none'; document.body.style.overflow = ''; document.getElementById('clEditGameMessage').innerHTML = ''; }

async function clApi(method, path, body) {
    var opts = { method: method, headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var r = await fetch(`${API_BASE}${path}`, opts);
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
}

async function clLoadLists() {
    try {
        var d = await clApi('GET', '/user/lists');
        clLists = d.lists;
        clRenderAccordion();
    } catch (e) { clShowToast(e.message, 'error'); }
}

function clRenderAccordion() {
    var container = document.getElementById('clAccordion');
    if (clLists.length === 0) {
        container.innerHTML = '<div class="coll-empty-state"><div class="coll-empty-icon">No lists yet</div><p>Hit <strong>+ New List</strong> to create one.</p></div>';
        return;
    }
    container.innerHTML = clLists.map(function(list) { return clRenderAccordionRow(list); }).join('');

    container.querySelectorAll('.cl-acc-header').forEach(function(header) {
        header.addEventListener('click', function(e) {
            if (e.target.closest('.btn')) return;
            var listId = parseInt(header.closest('.cl-acc-row').dataset.listId);
            clToggleAccordion(listId);
        });
    });

    container.querySelectorAll('.cl-acc-edit-list-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var list = clLists.find(function(l) { return l.id === parseInt(btn.dataset.listId); });
            if (list) clOpenListForm(list);
        });
    });
    container.querySelectorAll('.cl-acc-delete-list-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var list = clLists.find(function(l) { return l.id === parseInt(btn.dataset.listId); });
            if (list) clOpenDeleteModal(list);
        });
    });

    if (clExpandedListId) {
        var row = container.querySelector('.cl-acc-row[data-list-id="' + clExpandedListId + '"]');
        if (row) clExpandRow(row, clExpandedListId, false);
    }
}

function clRenderAccordionRow(list) {
    var count      = list.game_count || 0;
    var isExpanded = clExpandedListId === list.id;
    return '<div class="cl-acc-row ' + (isExpanded ? 'expanded' : '') + '" data-list-id="' + list.id + '">' +
        '<div class="cl-acc-header">' +
            '<div class="cl-acc-header-left">' +
                '<span class="cl-acc-chevron">' + (isExpanded ? 'v' : '>') + '</span>' +
                '<div class="cl-acc-title-group">' +
                    '<div class="cl-acc-title-row">' +
                        '<span class="cl-acc-name">' + esc(list.name) + '</span>' +
                        '<span class="pill">' + count + ' ' + (count === 1 ? 'game' : 'games') + '</span>' +
                        '<span class="pill ' + (list.is_public ? 'pill-green' : 'pill-amber') + '">' + (list.is_public ? 'Public' : 'Private') + '</span>' +
                    '</div>' +
                    (list.description ? '<div class="cl-acc-desc">' + esc(list.description) + '</div>' : '') +
                '</div>' +
            '</div>' +
            '<div class="cl-acc-header-right">' +
                '<button class="btn btn-secondary btn-sm cl-acc-edit-list-btn" data-list-id="' + list.id + '">Edit List</button>' +
                '<button class="btn btn-danger btn-sm cl-acc-delete-list-btn" data-list-id="' + list.id + '">Delete</button>' +
            '</div>' +
        '</div>' +
        '<div class="cl-acc-body ' + (isExpanded ? '' : 'hidden') + '" id="cl-acc-body-' + list.id + '"></div>' +
    '</div>';
}

async function clToggleAccordion(listId) {
    var container = document.getElementById('clAccordion');
    var row = container.querySelector('.cl-acc-row[data-list-id="' + listId + '"]');
    if (!row) return;
    var isCurrentlyExpanded = clExpandedListId === listId;
    container.querySelectorAll('.cl-acc-row').forEach(function(r) {
        r.classList.remove('expanded');
        r.querySelector('.cl-acc-chevron').textContent = '>';
        r.querySelector('.cl-acc-body').classList.add('hidden');
    });
    if (isCurrentlyExpanded) { clExpandedListId = null; return; }
    clExpandedListId = listId;
    clExpandRow(row, listId, true);
}

async function clExpandRow(row, listId, doFetch) {
    row.classList.add('expanded');
    row.querySelector('.cl-acc-chevron').textContent = 'v';
    var body = row.querySelector('.cl-acc-body');
    body.classList.remove('hidden');
    if (!clFilters[listId])   clFilters[listId]   = { search: '', sort: 'recently_added', status: 'all' };
    if (clIsEditMode[listId] === undefined) clIsEditMode[listId] = false;
    if (doFetch || !clListGames[listId]) {
        body.innerHTML = '<div class="coll-empty-state"><p>Loading...</p></div>';
        try {
            var d = await clApi('GET', '/user/lists/' + listId);
            clListGames[listId] = d.list.games || [];
        } catch (e) { body.innerHTML = '<div class="coll-empty-state"><p>Failed to load games.</p></div>'; return; }
    }
    clRenderListBody(listId);
}

function clRenderListBody(listId) {
    var body = document.getElementById('cl-acc-body-' + listId);
    if (!body) return;
    var f        = clFilters[listId];
    var editMode = clIsEditMode[listId];

    var statusOptions = ['all', 'playing', 'completed', 'plan_to_play', 'on_hold', 'dropped'];
    var statusTabsHtml = statusOptions.map(function(s) {
        return '<button class="status-tab ' + (f.status === s ? 'active' : '') + '" data-status="' + s + '">' + (s === 'all' ? 'All' : STATUS_LABEL[s]) + '</button>';
    }).join('');

    body.innerHTML =
        '<div class="cl-acc-toolbar">' +
            '<div class="cl-acc-list-header">' +
                '<div class="cl-acc-list-header-inputs">' +
                    '<input type="text" class="search-input cl-acc-search" placeholder="Search games..." value="' + esc(f.search) + '">' +
                    '<select class="filter-select cl-acc-sort">' +
                        '<option value="recently_added"' + (f.sort === 'recently_added' ? ' selected' : '') + '>Recently Added</option>' +
                        '<option value="name"'          + (f.sort === 'name'           ? ' selected' : '') + '>Name (A-Z)</option>' +
                        '<option value="name_desc"'     + (f.sort === 'name_desc'      ? ' selected' : '') + '>Name (Z-A)</option>' +
                        '<option value="score_high"'    + (f.sort === 'score_high'     ? ' selected' : '') + '>Score (High to Low)</option>' +
                        '<option value="score_low"'     + (f.sort === 'score_low'      ? ' selected' : '') + '>Score (Low to High)</option>' +
                    '</select>' +
                '</div>' +
                '<div class="cl-acc-list-header-btns">' +
                    '<button class="btn btn-secondary btn-sm cl-acc-edit-btn"' + (editMode ? ' style="display:none;"' : '') + '>Edit</button>' +
                    '<button class="btn btn-success btn-sm cl-acc-done-btn"'   + (editMode ? '' : ' style="display:none;"') + '>Done</button>' +
                '</div>' +
            '</div>' +
            '<div class="status-tabs cl-acc-status-tabs">' + statusTabsHtml + '</div>' +
        '</div>' +
        '<div class="my-games-list" id="cl-acc-games-' + listId + '"></div>';

    body.querySelector('.cl-acc-search').addEventListener('input', function(e) { clFilters[listId].search = e.target.value.toLowerCase().trim(); clRenderAccGames(listId); });
    body.querySelector('.cl-acc-sort').addEventListener('change',  function(e) { clFilters[listId].sort = e.target.value; clRenderAccGames(listId); });
    body.querySelector('.cl-acc-edit-btn').addEventListener('click', function() { clIsEditMode[listId] = true;  clRenderListBody(listId); });
    body.querySelector('.cl-acc-done-btn').addEventListener('click', function() { clIsEditMode[listId] = false; clRenderListBody(listId); });
    body.querySelectorAll('.cl-acc-status-tabs .status-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            clFilters[listId].status = tab.dataset.status;
            body.querySelectorAll('.cl-acc-status-tabs .status-tab').forEach(function(t) { t.classList.remove('active'); });
            tab.classList.add('active');
            clRenderAccGames(listId);
        });
    });
    clRenderAccGames(listId);
}

function clRenderAccGames(listId) {
    var container = document.getElementById('cl-acc-games-' + listId);
    if (!container) return;
    var f        = clFilters[listId];
    var editMode = clIsEditMode[listId];
    var games    = (clListGames[listId] || []).slice();
    if (currentMediaFilter !== 'all') games = games.filter(function(g) { return (g.media_type || 'game') === currentMediaFilter; });
    if (f.status !== 'all') games = games.filter(function(g) { return g.status === f.status; });
    if (f.search) games = games.filter(function(g) { return g.name.toLowerCase().includes(f.search); });
    switch (f.sort) {
        case 'name':           games.sort(function(a,b) { return a.name.localeCompare(b.name); }); break;
        case 'name_desc':      games.sort(function(a,b) { return b.name.localeCompare(a.name); }); break;
        case 'score_high':     games.sort(function(a,b) { return (b.user_score||0)-(a.user_score||0); }); break;
        case 'score_low':      games.sort(function(a,b) { return (a.user_score||0)-(b.user_score||0); }); break;
        case 'recently_added':
        default:               games.sort(function(a,b) { return new Date(b.added_at||0)-new Date(a.added_at||0); }); break;
    }
    if (games.length === 0) {
        var msg = f.search ? 'No games matching "' + f.search + '".' : f.status !== 'all' ? 'No games with status "' + (STATUS_LABEL[f.status] || f.status) + '".' : 'No games in this list yet.';
        container.innerHTML = '<div class="coll-empty-state" style="padding:30px 20px;"><p>' + msg + '</p></div>';
        return;
    }
    container.innerHTML = games.map(function(g) { return clRenderGameRow(g, listId, editMode); }).join('');
    container.querySelectorAll('.cl-list-item[data-game-id]').forEach(function(row) {
        row.addEventListener('click', function(e) {
            if (e.target.closest('.btn') || e.target.closest('.coll-item-edit-actions')) return;
            clShowGameDetails(row.dataset.gameId);
        });
    });
    container.querySelectorAll('.cl-edit-game-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) { e.stopPropagation(); clOpenEditGameModal(btn.dataset.gameId, btn.dataset.listId, btn.dataset.gameName, btn.dataset.score, btn.dataset.status); });
    });
    container.querySelectorAll('.cl-remove-game-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) { e.stopPropagation(); clOpenRemoveGameModal(btn.dataset.gameId, btn.dataset.listId, btn.dataset.gameName); });
    });
}

function clRenderGameRow(g, listId, editMode) {
    var score       = g.user_score ? g.user_score : '-';
    var statusColor = STATUS_COLOR[g.status] || '#555';
    var statusLabel = STATUS_LABEL[g.status] || (g.status ? g.status : 'No Status');
    var imgSrc      = g.background_image || '/img/no-image.svg';
    var editActions = editMode
        ? '<div class="coll-item-edit-actions">' +
              '<button class="btn btn-secondary btn-sm cl-edit-game-btn" data-game-id="' + g.game_id + '" data-list-id="' + listId + '" data-game-name="' + esc(g.name) + '" data-score="' + (g.user_score || '') + '" data-status="' + (g.status || '') + '">Edit</button>' +
              '<button class="btn btn-danger btn-sm cl-remove-game-btn" data-game-id="' + g.game_id + '" data-list-id="' + listId + '" data-game-name="' + esc(g.name) + '">Remove</button>' +
          '</div>'
        : '';
    var statusMetaHtml = statusLabel !== 'No Status'
        ? '<span class="status-dot-inline" style="background:' + statusColor + ';"></span><span class="coll-item-status">' + statusLabel + '</span>'
        : '<span class="coll-item-status" style="color:var(--text-dim);">No status</span>';

    return '<div class="coll-item cl-list-item" data-game-id="' + g.game_id + '" data-list-id="' + listId + '">' +
        '<img src="' + imgSrc + '" alt="' + esc(g.name) + '" class="coll-item-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
        '<div class="coll-item-body">' +
            '<div class="coll-item-main">' +
                '<div class="coll-item-name">' + esc(g.name) + '</div>' +
                '<div class="coll-item-meta">' + statusMetaHtml + '</div>' +
            '</div>' +
            '<div class="coll-item-right"><div class="coll-score-badge">' + score + '</div>' + editActions + '</div>' +
        '</div>' +
    '</div>';
}

async function clShowGameDetails(gameId) {
    try {
        var response = await fetch(`${API_BASE}/games/${gameId}`);
        var game = await response.json();
        if (!response.ok) return;
        var heroBg = game.background_image || '/img/no-image.svg';
        var infoItems = buildDetailInfoItems(game);

        var genreTagsHtml = (game.genres || []).length
            ? '<div class="game-detail-genres">' + game.genres.map(function(g) { return '<span class="game-detail-genre-tag">' + esc(g.name || g) + '</span>'; }).join('') + '</div>'
            : '';
        var infoGridHtml = infoItems.length
            ? '<div class="game-detail-info-grid">' + infoItems.map(function(i) { return '<div class="game-detail-info-item"><div class="game-detail-info-label">' + esc(i.label) + '</div><div class="game-detail-info-value">' + esc(i.value) + '</div></div>'; }).join('') + '</div>'
            : '';
        var releasedBadge = game.released
            ? '<span class="game-detail-date">' + new Date(game.released).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }) + '</span>'
            : '';

        document.getElementById('clGameDetails').innerHTML =
            '<div class="game-detail-hero"><img src="' + heroBg + '" alt="' + esc(game.name) + ' banner" class="game-detail-hero-img" loading="lazy" onerror="this.src=\'/img/no-image.svg\'"></div>' +
            '<div class="game-detail-body">' +
                '<div class="game-detail-title-row">' +
                    '<img src="' + heroBg + '" alt="' + esc(game.name) + ' cover" class="game-detail-cover" loading="lazy" onerror="this.src=\'/img/no-image.svg\'">' +
                    '<div class="game-detail-title-meta">' +
                        '<div class="game-detail-title">' + esc(game.name) + '</div>' +
                        '<div class="game-detail-badges">' + releasedBadge + '</div>' +
                    '</div>' +
                '</div>' +
                genreTagsHtml + infoGridHtml +
                (game.description ? '<p class="game-detail-desc">' + game.description + '</p>' : '') +
            '</div>';
        clOpenModal('clGameModal');
    } catch (error) { console.error('Show CL game details error:', error); }
}

function clOpenListForm(list) {
    clEditingId = list ? list.id : null;
    document.getElementById('clListFormTitle').textContent  = list ? 'Edit List' : 'Create New List';
    document.getElementById('clListFormSubmit').textContent = list ? 'Save Changes' : 'Create List';
    document.getElementById('clListName').value             = list ? list.name : '';
    document.getElementById('clListDesc').value             = list ? (list.description || '') : '';
    document.getElementById('clListPublic').checked         = list ? !!list.is_public : true;
    clUpdateCharCount('clListName', 'clListNameCount', 100);
    clUpdateCharCount('clListDesc', 'clListDescCount', 500);
    clOpenModal('clListFormModal');
    setTimeout(function() { document.getElementById('clListName').focus(); }, 100);
}

async function clSubmitListForm() {
    var name      = document.getElementById('clListName').value.trim();
    var desc      = document.getElementById('clListDesc').value.trim();
    var is_public = document.getElementById('clListPublic').checked;
    if (!name) { clShowToast('Please enter a list name', 'error'); return; }
    var btn = document.getElementById('clListFormSubmit');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
        var body = { name: name, description: desc || null, cover_color: '#3a7bd5', is_public: is_public };
        if (clEditingId) { await clApi('PUT',  '/user/lists/' + clEditingId, body); clShowToast('List updated!', 'success'); }
        else             { await clApi('POST', '/user/lists',               body); clShowToast('List created!', 'success'); }
        clCloseModal('clListFormModal');
        await clLoadLists();
    } catch (e) { clShowToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = clEditingId ? 'Save Changes' : 'Create List'; }
}

function clOpenDeleteModal(list) {
    _clPendingDeleteId = list.id;
    document.getElementById('clDeleteListName').textContent = list.name;
    clOpenModal('clDeleteListModal');
}

async function clConfirmDeleteList() {
    if (!_clPendingDeleteId) return;
    var btn = document.getElementById('clDeleteListConfirm');
    btn.disabled = true; btn.textContent = 'Deleting...';
    try {
        await clApi('DELETE', '/user/lists/' + _clPendingDeleteId);
        clShowToast('List deleted', 'success');
        clCloseModal('clDeleteListModal');
        if (clExpandedListId === _clPendingDeleteId) clExpandedListId = null;
        delete clListGames[_clPendingDeleteId];
        delete clFilters[_clPendingDeleteId];
        delete clIsEditMode[_clPendingDeleteId];
        await clLoadLists();
    } catch (e) { clShowToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Delete'; _clPendingDeleteId = null; }
}

var _clEditGameId = null;
var _clEditListId = null;

function clOpenEditGameModal(gameId, listId, gameName, existingScore, existingStatus) {
    _clEditGameId = gameId;
    _clEditListId = listId;
    document.getElementById('clEditGameName').textContent   = gameName || '';
    document.getElementById('clEditScoreInput').value       = existingScore || '';
    document.getElementById('clEditGameMessage').innerHTML  = '';
    document.getElementById('clEditStatusSelect').value     = existingStatus || 'plan_to_play';
    clOpenEditModal();
    setTimeout(function() {
        var inp = document.getElementById('clEditScoreInput');
        var clr = document.getElementById('clEditScoreClearBtn');
        inp.focus();
        if (clr) clr.onclick = function() { inp.value = ''; };
        inp.addEventListener('input', function() {
            var v = inp.value.replace(/[^0-9]/g, '');
            inp.value = v ? Math.min(10, Math.max(1, parseInt(v))) : '';
        });
    }, 100);
}

async function clSaveEditGame() {
    var scoreVal = document.getElementById('clEditScoreInput').value;
    var score    = scoreVal ? parseInt(scoreVal) : null;
    var status   = document.getElementById('clEditStatusSelect').value || null;
    var msgDiv   = document.getElementById('clEditGameMessage');
    if (scoreVal && (score < 1 || score > 10)) { showError(msgDiv, 'Score must be between 1 and 10'); return; }
    var btn = document.getElementById('clEditGameSave');
    btn.disabled = true;
    try {
        await clApi('PUT', '/user/lists/' + _clEditListId + '/games/' + _clEditGameId, { score: score, status: status });
        var games = clListGames[_clEditListId];
        if (games) {
            var game = games.find(function(g) { return g.game_id == _clEditGameId; });
            if (game) { game.user_score = score; game.status = status; }
        }
        showSuccess(msgDiv, 'Game updated successfully!');
        setTimeout(function() { clCloseEditModal(); clRenderAccGames(_clEditListId); }, 1500);
    } catch (e) { showError(msgDiv, e.message); }
    finally { btn.disabled = false; }
}

function clOpenRemoveGameModal(gameId, listId, gameName) {
    clRemoveGameId = gameId;
    _clEditListId  = listId;
    document.getElementById('clRemoveGameName').textContent = gameName;
    clOpenModal('clRemoveGameModal');
}

async function clConfirmRemoveGame() {
    var btn = document.getElementById('clRemoveGameConfirm');
    btn.disabled = true;
    try {
        await clApi('DELETE', '/user/lists/' + _clEditListId + '/games/' + clRemoveGameId);
        clShowToast('Game removed', 'success');
        clCloseModal('clRemoveGameModal');
        if (clListGames[_clEditListId]) {
            clListGames[_clEditListId] = clListGames[_clEditListId].filter(function(g) { return g.game_id != clRemoveGameId; });
        }
        clRenderAccGames(_clEditListId);
        var list = clLists.find(function(l) { return l.id == _clEditListId; });
        if (list) { list.game_count = Math.max(0, (list.game_count || 1) - 1); clRenderAccordion(); }
    } catch (e) { clShowToast(e.message, 'error'); }
    finally { btn.disabled = false; }
}

var _clModalEscBound = false;
function clOpenModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    var focusable = el.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
    if (!_clModalEscBound) {
        _clModalEscBound = true;
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            document.querySelectorAll('.cl-modal-overlay.open').forEach(function (m) {
                m.classList.remove('open');
            });
            document.body.style.overflow = '';
        });
    }
}
function clCloseModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
    document.body.style.overflow = '';
}

function clUpdateCharCount(inputId, countId, max) {
    var len = document.getElementById(inputId).value.length;
    var el  = document.getElementById(countId);
    el.textContent = len + ' / ' + max;
    el.className   = 'cl-char-count' + (len > max * 0.88 ? ' warn' : '');
}

var _clToastTimer;
function clShowToast(msg, type) {
    type = type || '';
    var el = document.getElementById('clToast');
    el.textContent = msg;
    el.className   = 'cl-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(_clToastTimer);
    _clToastTimer = setTimeout(function() { el.classList.remove('show'); }, 3000);
}

function showError(element, message) {
    if (typeof element === 'string') element = document.getElementById(element);
    var safe = (typeof esc === 'function') ? esc(message) : String(message || '');
    element.innerHTML = '<div class="error">' + safe + '</div>';
}
function showSuccess(element, message) {
    if (typeof element === 'string') element = document.getElementById(element);
    var safe = (typeof esc === 'function') ? esc(message) : String(message || '');
    element.innerHTML = '<div class="success">' + safe + '</div>';
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