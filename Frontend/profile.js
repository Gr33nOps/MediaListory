const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '/api';

let authToken   = localStorage.getItem('authToken');
let currentUser = (typeof getStoredUser === 'function') ? getStoredUser() : null;

(async function bootProfile() {
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
    var welcomeText = document.getElementById('welcomeText');
    if (welcomeText) welcomeText.textContent = 'Welcome, ' + currentUser.display_name + '!';

    var logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

    document.getElementById('editProfileBtn').addEventListener('click', showEditMode);
    document.getElementById('cancelEditBtn').addEventListener('click', showDisplayMode);
    document.getElementById('changePasswordBtn').addEventListener('click', showPasswordModal);
    var exportBtn = document.getElementById('exportDataBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', function () {
            var sel = document.getElementById('exportCategory');
            exportMyData(sel ? sel.value : '');
        });
    }
    var backupBtn = document.getElementById('backupDataBtn');
    if (backupBtn) backupBtn.addEventListener('click', function () { exportMyData(''); });

    var densitySelect = document.getElementById('densitySelect');
    if (densitySelect && typeof getDensity === 'function') {
        densitySelect.value = getDensity();
        densitySelect.addEventListener('change', function () {
            if (typeof applyDensity === 'function') applyDensity(densitySelect.value);
            if (typeof notify === 'function') notify('Display density updated', 'success');
        });
    }
    document.getElementById('cancelPasswordBtn').addEventListener('click', closePasswordModal);
    document.getElementById('editProfileForm').addEventListener('submit', handleProfileUpdate);
    document.getElementById('changePasswordForm').addEventListener('submit', handlePasswordChange);

    initAvatarUpload();

    if (typeof bindModal === 'function') {
        bindModal('passwordModal', 'closePasswordModal');
    } else {
        document.getElementById('closePasswordModal').addEventListener('click', closePasswordModal);
        document.getElementById('passwordModal').addEventListener('click', function(e) {
            if (e.target.id === 'passwordModal') closePasswordModal();
        });
    }

    loadProfile();
}

async function loadProfile() {
    try {
        var profileResponse = await fetch(`${API_BASE}/user/profile`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (profileResponse.ok) {
            var profileData = await profileResponse.json();
            displayProfile(profileData.user);
        }

        showStatsSkeleton();

        var results = await Promise.all([
            fetch(`${API_BASE}/user/games`,  { headers: { 'Authorization': `Bearer ${authToken}` } }),
            fetch(`${API_BASE}/followers`,    { headers: { 'Authorization': `Bearer ${authToken}` } }),
            fetch(`${API_BASE}/following`,    { headers: { 'Authorization': `Bearer ${authToken}` } })
        ]);

        var gamesData     = await results[0].json();
        var followersData = await results[1].json();
        var followingData = await results[2].json();

        displayStats(gamesData.games, followersData.followers, followingData.following);
        initProfileManagers(gamesData.games);
    } catch (error) {
        console.error('Load profile error:', error);
    }
}

function displayProfile(user) {
    var avatarUrl = user.avatar_url ||
        'https://ui-avatars.com/api/?name=' + encodeURIComponent(user.display_name || user.username) + '&size=200&background=3b82f6&color=fff&bold=true';

    document.getElementById('displayAvatar').src           = avatarUrl;
    document.getElementById('editAvatarPreview').src       = avatarUrl;
    document.getElementById('displayName').textContent     = user.display_name || '-';
    document.getElementById('displayUsername').textContent = user.username;
    document.getElementById('displayEmail').textContent    = user.email;
    document.getElementById('displayCreatedAt').textContent = formatDate(user.created_at);
    document.getElementById('editDisplayName').value       = user.display_name || '';
    document.getElementById('editEmail').value             = user.email;
    var avaData = document.getElementById('editAvatarData'); if (avaData) avaData.value = user.avatar_url || '';
    var priv = document.getElementById('editPrivate'); if (priv) priv.checked = !!user.is_private;
    var clr = document.getElementById('avatarClearBtn'); if (clr) clr.style.display = user.avatar_url ? 'inline-block' : 'none';
    initProfileCustomisation(user);
}

// An animated avatar has to stay small: avatar_url is a data URI stored on the
// user row and returned inline with every profile, friends list, and search
// result, so a heavy one is paid for on each of those responses.
var GIF_MAX_BYTES = 256 * 1024;

// Count graphic control extension blocks. One means a single frame, so a static
// GIF still takes the downscale path below rather than being kept at full size.
function isAnimatedGif(binary) {
    var seen = 0, i = 0;
    while ((i = binary.indexOf('\x21\xF9\x04', i)) !== -1) {
        if (++seen > 1) return true;
        i += 3;
    }
    return false;
}

// Read a chosen image, cover-crop to a square, downscale, and return a small
// JPEG data URL so any photo from the user's device becomes a light avatar.
// An animated GIF is the exception and is kept byte for byte: every canvas pass
// below composites a single frame, which is what silently flattened them before.
function readImageToDataUrl(file, cb) {
    if (!file || !/^image\//.test(file.type)) { cb(null, 'type'); return; }
    var reader = new FileReader();
    reader.onload = function () {
        var dataUrl = String(reader.result || '');
        if (file.type === 'image/gif') {
            var binary = '';
            try { binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1)); } catch (_) {}
            if (binary && isAnimatedGif(binary)) {
                if (file.size > GIF_MAX_BYTES) { cb(null, 'gifsize'); return; }
                cb(dataUrl);
                return;
            }
        }
        var img = new Image();
        img.onload = function () {
            var size = 256;
            var canvas = document.createElement('canvas');
            canvas.width = size; canvas.height = size;
            var ctx = canvas.getContext('2d');
            var s = Math.min(img.width, img.height);
            var sx = (img.width - s) / 2, sy = (img.height - s) / 2;
            ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
            try { cb(canvas.toDataURL('image/jpeg', 0.82)); } catch (_) { cb(null); }
        };
        img.onerror = function () { cb(null); };
        img.src = dataUrl;
    };
    reader.onerror = function () { cb(null); };
    reader.readAsDataURL(file);
}

function initAvatarUpload() {
    var drop = document.getElementById('avatarDrop');
    var fileInput = document.getElementById('avatarFile');
    var preview = document.getElementById('editAvatarPreview');
    var dataField = document.getElementById('editAvatarData');
    var clearBtn = document.getElementById('avatarClearBtn');
    if (!drop || !fileInput) return;

    function handleFile(file) {
        if (file && file.size > 8 * 1024 * 1024) { flashEdit('That image is too large (max 8MB).', true); return; }
        readImageToDataUrl(file, function (url, reason) {
            if (!url) {
                // An animated GIF is stored whole, so its own limit is much lower
                // than the 8MB one above and needs to say so.
                flashEdit(reason === 'gifsize'
                    ? 'That GIF is too large. Animated pictures have to stay under 256KB, because they are sent in full every time your profile appears.'
                    : 'Could not read that image. Try a JPG, PNG, or GIF.', true);
                return;
            }
            preview.src = url; dataField.value = url;
            if (clearBtn) clearBtn.style.display = 'inline-block';
        });
    }
    drop.addEventListener('click', function () { fileInput.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    fileInput.addEventListener('change', function () { if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]); });
    ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-drag'); }); });
    ['dragleave', 'dragend'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-drag'); }); });
    drop.addEventListener('drop', function (e) {
        e.preventDefault(); drop.classList.remove('is-drag');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFile(f);
    });
    if (clearBtn) clearBtn.addEventListener('click', function () {
        dataField.value = '';
        preview.src = 'https://ui-avatars.com/api/?name=' + encodeURIComponent((currentUser && (currentUser.display_name || currentUser.username)) || 'User') + '&size=200&background=475569&color=fff&bold=true';
        clearBtn.style.display = 'none';
    });
}

function flashEdit(msg, isErr) {
    var m = document.getElementById('editMessage');
    if (m) m.innerHTML = '<div class="' + (isErr ? 'error-message' : 'success-message') + '">' + msg + '</div>';
}

function showStatsSkeleton() {
    ['userLevel', 'totalGames', 'followersCount', 'followingCount'].forEach(function(id) {
        var e = document.getElementById(id);
        if (e) e.innerHTML = '<span class="skeleton stat-skel"></span>';
    });
    var bd = document.getElementById('mediaBreakdown');
    if (bd) {
        bd.className = 'cat-breakdown';
        bd.removeAttribute('style');
        bd.innerHTML = new Array(4).fill('<span class="cat-stat"><span class="skeleton stat-skel"></span>' +
            '<span class="skeleton skel-line w50" style="margin-top:6px;"></span></span>').join('');
    }
}

function displayStats(games, followers, following) {
    var totalGames = games.length;
    document.getElementById('userLevel').textContent      = calculateLevel(totalGames);
    var tg = document.getElementById('totalGames'); if (tg) tg.textContent = totalGames;
    document.getElementById('followersCount').textContent = followers.length;
    document.getElementById('followingCount').textContent = following.length;

    var breakdown = { game: 0, movie: 0, series: 0, anime: 0 };
    games.forEach(function(g) {
        var t = g.media_type || 'game';
        if (breakdown[t] === undefined) breakdown[t] = 0;
        breakdown[t]++;
    });
    var el = document.getElementById('mediaBreakdown');
    if (el) {
        var order = [['movie', 'Movies', 'movies.html'], ['series', 'Shows', 'series.html'], ['anime', 'Anime', 'anime.html'], ['game', 'Games', 'home.html']];
        el.className = 'cat-breakdown';
        el.removeAttribute('style');
        el.innerHTML = order.map(function(o) {
            return '<a class="cat-stat" data-cat="' + o[0] + '" href="library.html" title="View your ' + o[1] + '">' +
                '<span class="cs-num">' + (breakdown[o[0]] || 0) + '</span>' +
                '<span class="cs-label">' + o[1] + '</span></a>';
        }).join('');
    }
}

function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
}

function showEditMode() {
    document.getElementById('profileDisplay').classList.add('hidden');
    document.getElementById('profileEdit').classList.remove('hidden');
    document.getElementById('editMessage').innerHTML = '';
}

function showDisplayMode() {
    document.getElementById('profileEdit').classList.add('hidden');
    document.getElementById('profileDisplay').classList.remove('hidden');
}

async function handleProfileUpdate(e) {
    e.preventDefault();
    var messageDiv  = document.getElementById('editMessage');
    var displayName = document.getElementById('editDisplayName').value;
    var email       = document.getElementById('editEmail').value;
    var avaData     = document.getElementById('editAvatarData');
    var avatarUrl   = avaData ? (avaData.value || null) : null;
    var privEl      = document.getElementById('editPrivate');
    var isPrivate   = !!(privEl && privEl.checked);

    try {
        var response = await fetch(`${API_BASE}/user/profile`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(Object.assign(
                { display_name: displayName, email: email, avatar_url: avatarUrl, is_private: isPrivate },
                profileCustomisationPayload()
            ))
        });
        var data = await response.json();

        if (response.ok) {
            showSuccess(messageDiv, 'Profile updated successfully!');
            currentUser = Object.assign({}, currentUser, data.user);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            setTimeout(function() { loadProfile(); showDisplayMode(); }, 1500);
        } else {
            showError(messageDiv, data.error || 'Failed to update profile');
        }
    } catch (error) {
        console.error('Update profile error:', error);
        showError(messageDiv, 'Network error. Please try again.');
    }
}

function showPasswordModal() {
    document.getElementById('changePasswordForm').reset();
    document.getElementById('passwordMessage').innerHTML = '';
    if (typeof openModal === 'function') openModal('passwordModal', { focusSelector: '#currentPassword' });
    else document.getElementById('passwordModal').style.display = 'block';
}

function closePasswordModal() {
    if (typeof closeModal === 'function') closeModal('passwordModal');
    else document.getElementById('passwordModal').style.display = 'none';
}

async function handlePasswordChange(e) {
    e.preventDefault();
    var messageDiv      = document.getElementById('passwordMessage');
    var currentPassword = document.getElementById('currentPassword').value;
    var newPassword     = document.getElementById('newPassword').value;
    var confirmPassword = document.getElementById('confirmPassword').value;

    if (newPassword !== confirmPassword) {
        showError(messageDiv, 'New passwords do not match');
        return;
    }
    if (newPassword.length < 8) {
        showError(messageDiv, 'Password must be at least 8 characters');
        return;
    }

    try {
        var response = await fetch(`${API_BASE}/user/password`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
        });
        var data = await response.json();

        if (response.ok) {
            showSuccess(messageDiv, 'Password updated successfully!');
            setTimeout(closePasswordModal, 1500);
        } else {
            showError(messageDiv, data.error || 'Failed to update password');
        }
    } catch (error) {
        console.error('Update password error:', error);
        showError(messageDiv, 'Network error. Please try again.');
    }
}

async function exportMyData(category) {
    var CAT_FILE = { movie: 'movies', series: 'shows', anime: 'anime', game: 'games' };
    var qs = category ? ('?category=' + encodeURIComponent(category)) : '';
    try {
        var r = await fetch((typeof API_BASE !== 'undefined' ? API_BASE : '/api') + '/user/export' + qs, {
            headers: { 'Authorization': 'Bearer ' + authToken }
        });
        if (!r.ok) {
            var d = await r.json().catch(function() { return {}; });
            var msg = typeof describeApiError === 'function'
                ? describeApiError(r, d, 'Export failed')
                : (d.error || 'Export failed');
            if (typeof toast === 'function') toast(msg, 'error');
            else notify(msg, 'error');
            return;
        }
        var blob = await r.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = category ? ('medialistory-' + (CAT_FILE[category] || category) + '.json') : 'medialistory-backup.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        var okMsg = category ? ('Exported your ' + (CAT_FILE[category] || category)) : 'Full backup downloaded';
        if (typeof toast === 'function') toast(okMsg, 'success');
    } catch (e) {
        if (typeof toast === 'function') toast('Network error exporting data', 'error');
        else notify('Network error exporting data', 'error');
    }
}

function logout() {
    if (typeof logoutToAuth === 'function') logoutToAuth();
    else {
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        window.location.href = 'auth.html';
    }
}

function showError(element, message) {
    var safe = (typeof esc === 'function') ? esc(message) : String(message || '');
    element.innerHTML = '<div class="error">' + safe + '</div>';
}

function showSuccess(element, message) {
    var safe = (typeof esc === 'function') ? esc(message) : String(message || '');
    element.innerHTML = '<div class="success">' + safe + '</div>';
}

/* ── Customising your own profile ──────────────────────────────────────────
   The Top 10s and the "Currently into" picker. Both draw from the library that
   is already loaded for the stats above, so neither costs an extra round trip
   on load, and a Top 10 can only hold things you actually track. That keeps the
   rankings honest and means every Top 10 entry also feeds Similar Taste. */

var MG_ORDER  = ['movie', 'series', 'anime', 'game'];
var MG_LABEL  = { movie: 'Movies', series: 'Shows', anime: 'Anime', game: 'Games' };
var MG_FALLBACK = '/img/no-image.svg';
var MG_TOP_MAX = 10;
var MG_CURRENT_MAX = 6;

var mgLibrary = [];       // everything in my library, for the picker
var mgTop = { movie: [], series: [], anime: [], game: [] };
var mgActiveCat = 'movie';
var mgCurrentPinned = [];

function mgEsc(v) {
    return (typeof esc === 'function') ? esc(v) : String(v == null ? '' : v);
}

/* /user/games returns the numeric join id as game_id and the universal external
   ref (tmdb_movie_123 and friends) as media_ref. Every profile API keys on the
   external ref, so that is what the pickers must send. */
function mgRef(g) {
    return String(g.media_ref || g.game_id);
}

function mgPoster(src, alt) {
    return '<img src="' + mgEsc(src || MG_FALLBACK) + '" alt="' + mgEsc(alt || '') + '" loading="lazy">';
}

function mgStatus(id, text, isError) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isError ? 'var(--red-light)' : 'var(--text-dim)';
}

/* Called once the library has loaded, so both managers can render from it. */
function initProfileManagers(games) {
    mgLibrary = Array.isArray(games) ? games : [];
    var topWrap = document.getElementById('topManager');
    var curWrap = document.getElementById('currentManager');
    if (topWrap) topWrap.hidden = false;
    if (curWrap) curWrap.hidden = false;

    mgCurrentPinned = mgLibrary.filter(function (g) { return g.show_on_profile; }).map(mgRef);

    renderCurrentPicker();
    loadTopMedia();
    wireManagers();
}

function wireManagers() {
    var add = document.getElementById('topAddBtn');
    var picker = document.getElementById('topPicker');
    var search = document.getElementById('topPickerSearch');
    if (add && picker && !add.dataset.wired) {
        add.dataset.wired = '1';
        add.addEventListener('click', function () {
            picker.hidden = !picker.hidden;
            add.textContent = picker.hidden ? 'Add a title' : 'Done adding';
            if (!picker.hidden) { renderPicker(''); if (search) search.focus(); }
        });
    }
    if (search && !search.dataset.wired) {
        search.dataset.wired = '1';
        search.addEventListener('input', function () { renderPicker(search.value); });
    }
    var save = document.getElementById('currentSaveBtn');
    if (save && !save.dataset.wired) {
        save.dataset.wired = '1';
        save.addEventListener('click', saveCurrentPicks);
    }
}

async function loadTopMedia() {
    try {
        var r = await fetch(API_BASE + '/user/profile/top', { headers: { Authorization: 'Bearer ' + authToken } });
        if (!r.ok) return;
        var d = await r.json();
        mgTop = d.top || mgTop;
        renderTopManager();
    } catch (_) { /* the section stays empty rather than blocking the page */ }
}

function renderTopManager() {
    var tabs = document.getElementById('topCatTabs');
    var list = document.getElementById('topEditList');
    var wrap = document.getElementById('topManager');
    if (!tabs || !list) return;

    if (wrap) wrap.setAttribute('data-accent', mgActiveCat);
    tabs.innerHTML = MG_ORDER.map(function (cat) {
        var n = (mgTop[cat] || []).length;
        var on = cat === mgActiveCat;
        return '<button type="button" role="tab" class="pf-chip' + (on ? ' active' : '') + '" data-cat="' + cat + '"' +
            ' aria-selected="' + on + '">' + MG_LABEL[cat] + (n ? ' (' + n + ')' : '') + '</button>';
    }).join('');
    tabs.querySelectorAll('.pf-chip').forEach(function (b) {
        b.addEventListener('click', function () {
            mgActiveCat = b.dataset.cat;
            mgStatus('topStatus', '');
            renderTopManager();
            var picker = document.getElementById('topPicker');
            if (picker && !picker.hidden) renderPicker(document.getElementById('topPickerSearch').value);
        });
    });

    var items = mgTop[mgActiveCat] || [];
    if (!items.length) {
        list.innerHTML = '<p class="pf-empty">Nothing ranked in ' + MG_LABEL[mgActiveCat].toLowerCase() +
            ' yet. Add up to ten and put them in the order you would defend.</p>';
        return;
    }

    list.innerHTML = items.map(function (it, i) {
        var last = i === items.length - 1;
        return '<div class="pf-edit-row">' +
            '<span class="pf-edit-pos">' + (i + 1) + '</span>' +
            mgPoster(it.background_image, '') +
            '<span class="pf-edit-name">' + mgEsc(it.name) + '</span>' +
            '<span class="pf-edit-actions">' +
                '<button type="button" class="pf-icon-btn" data-move="up" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') +
                    ' aria-label="Move ' + mgEsc(it.name) + ' up">&uarr;</button>' +
                '<button type="button" class="pf-icon-btn" data-move="down" data-i="' + i + '"' + (last ? ' disabled' : '') +
                    ' aria-label="Move ' + mgEsc(it.name) + ' down">&darr;</button>' +
                '<button type="button" class="pf-icon-btn" data-remove="' + i + '"' +
                    ' aria-label="Remove ' + mgEsc(it.name) + '">&times;</button>' +
            '</span>' +
        '</div>';
    }).join('');

    list.querySelectorAll('[data-move]').forEach(function (b) {
        b.addEventListener('click', function () {
            var i = parseInt(b.dataset.i, 10);
            var to = b.dataset.move === 'up' ? i - 1 : i + 1;
            var arr = mgTop[mgActiveCat];
            if (to < 0 || to >= arr.length) return;
            var tmp = arr[i]; arr[i] = arr[to]; arr[to] = tmp;
            renderTopManager();
            saveTop();
        });
    });
    list.querySelectorAll('[data-remove]').forEach(function (b) {
        b.addEventListener('click', function () {
            mgTop[mgActiveCat].splice(parseInt(b.dataset.remove, 10), 1);
            renderTopManager();
            saveTop();
        });
    });
}

/* The picker only offers titles of the active category that are not already
   ranked, so it is impossible to build an invalid list from the UI. */
function renderPicker(term) {
    var out = document.getElementById('topPickerResults');
    if (!out) return;
    var q = String(term || '').trim().toLowerCase();
    var ranked = (mgTop[mgActiveCat] || []).map(function (t) { return String(t.game_id); });

    var matches = mgLibrary.filter(function (g) {
        if ((g.media_type || 'game') !== mgActiveCat) return false;
        if (ranked.indexOf(mgRef(g)) !== -1) return false;
        return !q || String(g.name || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 40);

    if (!matches.length) {
        out.innerHTML = '<p class="pf-empty">' + (q
            ? 'No ' + MG_LABEL[mgActiveCat].toLowerCase() + ' in your library match that.'
            : 'Add some ' + MG_LABEL[mgActiveCat].toLowerCase() + ' to your library first.') + '</p>';
        return;
    }

    var full = (mgTop[mgActiveCat] || []).length >= MG_TOP_MAX;
    out.innerHTML = matches.map(function (g) {
        return '<button type="button" class="pf-picker-row" data-ref="' + mgEsc(mgRef(g)) + '"' +
            (full ? ' aria-disabled="true"' : '') + '>' +
            mgPoster(g.background_image, '') +
            '<span class="pf-edit-name">' + mgEsc(g.name) + '</span>' +
        '</button>';
    }).join('');

    out.querySelectorAll('.pf-picker-row').forEach(function (b) {
        b.addEventListener('click', function () {
            if ((mgTop[mgActiveCat] || []).length >= MG_TOP_MAX) {
                mgStatus('topStatus', 'That list is full. Remove one first.', true);
                return;
            }
            var g = mgLibrary.find(function (x) { return mgRef(x) === b.dataset.ref; });
            if (!g) return;
            mgTop[mgActiveCat].push({ game_id: mgRef(g), name: g.name, background_image: g.background_image });
            renderTopManager();
            renderPicker(document.getElementById('topPickerSearch').value);
            saveTop();
        });
    });
}

async function saveTop() {
    var cat = mgActiveCat;
    var refs = (mgTop[cat] || []).map(function (t) { return t.game_id; });
    mgStatus('topStatus', 'Saving...');
    try {
        var r = await fetch(API_BASE + '/user/profile/top/' + cat, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
            body: JSON.stringify({ game_ids: refs })
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) { mgStatus('topStatus', d.error || 'Could not save.', true); return; }
        mgStatus('topStatus', 'Saved');
        setTimeout(function () { mgStatus('topStatus', ''); }, 1600);
    } catch (_) {
        mgStatus('topStatus', 'Could not reach the server.', true);
    }
}

/* ── Currently into ───────────────────────────────────────────────────────── */

function renderCurrentPicker() {
    var list = document.getElementById('currentPickList');
    if (!list) return;
    var playing = mgLibrary.filter(function (g) { return g.status === 'playing'; });

    if (!playing.length) {
        list.innerHTML = '<p class="pf-empty">Nothing in progress right now. Set something to "In progress" and it shows up here.</p>';
        return;
    }

    list.innerHTML = playing.map(function (g) {
        var on = mgCurrentPinned.indexOf(mgRef(g)) !== -1;
        var verb = (g.media_type === 'game') ? 'Playing' : 'Watching';
        return '<label class="pf-edit-row">' +
            '<input type="checkbox" data-ref="' + mgEsc(mgRef(g)) + '"' + (on ? ' checked' : '') + '>' +
            mgPoster(g.background_image, '') +
            '<span class="pf-edit-name">' + mgEsc(g.name) + '</span>' +
            '<span class="pf-edit-pos" style="width:auto;font-size:0.75rem;">' + verb + '</span>' +
        '</label>';
    }).join('');

    list.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.addEventListener('change', function () {
            var picked = list.querySelectorAll('input[type="checkbox"]:checked');
            if (picked.length > MG_CURRENT_MAX) {
                cb.checked = false;
                mgStatus('currentStatus', 'You can pin at most ' + MG_CURRENT_MAX + '.', true);
            } else {
                mgStatus('currentStatus', '');
            }
        });
    });
}

async function saveCurrentPicks() {
    var list = document.getElementById('currentPickList');
    if (!list) return;
    var refs = [].slice.call(list.querySelectorAll('input[type="checkbox"]:checked'))
        .map(function (cb) { return cb.dataset.ref; });
    mgStatus('currentStatus', 'Saving...');
    try {
        var r = await fetch(API_BASE + '/user/profile/current', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
            body: JSON.stringify({ game_ids: refs })
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) { mgStatus('currentStatus', d.error || 'Could not save.', true); return; }
        mgCurrentPinned = refs.map(String);
        mgStatus('currentStatus', refs.length ? 'Saved' : 'Cleared, your profile follows what you touched most recently');
        setTimeout(function () { mgStatus('currentStatus', ''); }, 2600);
    } catch (_) {
        mgStatus('currentStatus', 'Could not reach the server.', true);
    }
}

/* ── Bio, colour, and header controls in the edit form ────────────────────── */

function initProfileCustomisation(user) {
    var bio = document.getElementById('editBio');
    var count = document.getElementById('bioCount');
    if (bio) {
        bio.value = user.bio || '';
        if (count) count.textContent = String(bio.value.length);
        if (!bio.dataset.wired) {
            bio.dataset.wired = '1';
            bio.addEventListener('input', function () {
                if (count) count.textContent = String(bio.value.length);
            });
        }
    }

    var banner = document.getElementById('editBanner');
    if (banner) banner.value = user.banner_style || 'posters';

    var swatches = document.getElementById('accentSwatches');
    if (!swatches) return;
    var chosen = user.accent || 'movie';
    swatches.querySelectorAll('.pf-swatch').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.cat === chosen));
        if (b.dataset.wired) return;
        b.dataset.wired = '1';
        b.addEventListener('click', function () {
            swatches.querySelectorAll('.pf-swatch').forEach(function (o) {
                o.setAttribute('aria-pressed', String(o === b));
            });
        });
    });
}

// What the edit form should send alongside the existing fields.
function profileCustomisationPayload() {
    var bio = document.getElementById('editBio');
    var banner = document.getElementById('editBanner');
    var pressed = document.querySelector('#accentSwatches .pf-swatch[aria-pressed="true"]');
    return {
        bio: bio ? bio.value : '',
        accent: pressed ? pressed.dataset.cat : null,
        banner_style: banner ? banner.value : 'posters'
    };
}
