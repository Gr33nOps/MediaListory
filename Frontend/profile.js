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

    initDangerZone();
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
        } else {
            clearProfileSkeleton();
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
        clearProfileSkeleton();
    }
}

// Fallback for a failed /user/profile fetch: stop the shimmer rather than
// leaving it animating forever over data that never arrived.
function clearProfileSkeleton() {
    ['displayName', 'displayUsername', 'displayEmail', 'displayCreatedAt'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.classList.contains('skeleton')) { el.classList.remove('skeleton'); el.textContent = '-'; }
    });
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
    ['displayName', 'displayUsername', 'displayEmail', 'displayCreatedAt'].forEach(function (id) {
        document.getElementById(id).classList.remove('skeleton');
    });
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

/* ── Danger zone: clear collection / delete account ──────────────────────
   Both use the same overlay+.open pattern as the custom-list modals so they
   match the rest of the app rather than introducing a second modal system. */
function dzOpenModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    var focusable = el.querySelector('input, button, [href]');
    if (focusable) focusable.focus();
}
function dzCloseModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
    document.body.style.overflow = '';
}

function initDangerZone() {
    var clearBtn = document.getElementById('clearDataBtn');
    if (clearBtn) clearBtn.addEventListener('click', function () {
        document.getElementById('clearDataMessage').innerHTML = '';
        dzOpenModal('clearDataModal');
    });
    document.getElementById('clearDataClose').addEventListener('click', function () { dzCloseModal('clearDataModal'); });
    document.getElementById('clearDataCancel').addEventListener('click', function () { dzCloseModal('clearDataModal'); });
    document.getElementById('clearDataModal').addEventListener('click', function (e) {
        if (e.target.id === 'clearDataModal') dzCloseModal('clearDataModal');
    });
    document.getElementById('clearDataConfirm').addEventListener('click', confirmClearData);

    var delBtn = document.getElementById('deleteAccountBtn');
    if (delBtn) delBtn.addEventListener('click', function () {
        var nameEl = document.getElementById('deleteAccountUsername');
        var inputEl = document.getElementById('deleteAccountConfirmInput');
        var okBtn = document.getElementById('deleteAccountConfirm');
        var uname = (currentUser && currentUser.username) || '';
        if (nameEl) nameEl.textContent = uname;
        if (inputEl) inputEl.value = '';
        if (okBtn) okBtn.disabled = true;
        document.getElementById('deleteAccountMessage').innerHTML = '';
        dzOpenModal('deleteAccountModal');
    });
    document.getElementById('deleteAccountClose').addEventListener('click', function () { dzCloseModal('deleteAccountModal'); });
    document.getElementById('deleteAccountCancel').addEventListener('click', function () { dzCloseModal('deleteAccountModal'); });
    document.getElementById('deleteAccountModal').addEventListener('click', function (e) {
        if (e.target.id === 'deleteAccountModal') dzCloseModal('deleteAccountModal');
    });
    document.getElementById('deleteAccountConfirmInput').addEventListener('input', function () {
        var uname = (currentUser && currentUser.username) || '';
        var okBtn = document.getElementById('deleteAccountConfirm');
        okBtn.disabled = !uname || this.value.trim().toLowerCase() !== uname.toLowerCase();
    });
    document.getElementById('deleteAccountConfirm').addEventListener('click', confirmDeleteAccount);

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        dzCloseModal('clearDataModal');
        dzCloseModal('deleteAccountModal');
    });
}

async function confirmClearData() {
    var btn = document.getElementById('clearDataConfirm');
    var msgDiv = document.getElementById('clearDataMessage');
    if (typeof setBtnLoading === 'function') setBtnLoading(btn, true, 'Clearing…'); else btn.disabled = true;
    try {
        var r = await fetch(`${API_BASE}/user/data`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        var data = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(data.error || 'Could not clear your data');
        if (typeof notify === 'function') notify('Your collection has been cleared.', 'success');
        else if (typeof toast === 'function') toast('Your collection has been cleared.', 'success');
        setTimeout(function () { window.location.reload(); }, 900);
    } catch (err) {
        showError(msgDiv, err.message || 'Could not clear your data. Please try again.');
        if (typeof setBtnLoading === 'function') setBtnLoading(btn, false); else btn.disabled = false;
    }
}

async function confirmDeleteAccount() {
    var btn = document.getElementById('deleteAccountConfirm');
    var msgDiv = document.getElementById('deleteAccountMessage');
    var inputEl = document.getElementById('deleteAccountConfirmInput');
    if (typeof setBtnLoading === 'function') setBtnLoading(btn, true, 'Deleting…'); else btn.disabled = true;
    try {
        var r = await fetch(`${API_BASE}/user/account`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: inputEl.value.trim() })
        });
        var data = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(data.error || 'Could not delete your account');
        logout();
    } catch (err) {
        showError(msgDiv, err.message || 'Could not delete your account. Please try again.');
        if (typeof setBtnLoading === 'function') setBtnLoading(btn, false); else btn.disabled = false;
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

var topEditing = false;
var currentEditing = false;
var mgCurrentCat = 'all';

/* Called once the library has loaded, so both managers can render from it. */
function initProfileManagers(games) {
    mgLibrary = Array.isArray(games) ? games : [];
    var topWrap = document.getElementById('topManager');
    var curWrap = document.getElementById('currentManager');
    if (topWrap) topWrap.hidden = false;
    if (curWrap) curWrap.hidden = false;

    mgCurrentPinned = mgLibrary.filter(function (g) { return g.show_on_profile; }).map(mgRef);

    renderCurrent();
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
    var topEdit = document.getElementById('topEditBtn');
    var topDone = document.getElementById('topDoneBtn');
    if (topEdit && !topEdit.dataset.wired) { topEdit.dataset.wired = '1'; topEdit.addEventListener('click', function () { setTopEditing(true); }); }
    if (topDone && !topDone.dataset.wired) { topDone.dataset.wired = '1'; topDone.addEventListener('click', function () { setTopEditing(false); }); }

    var curAdd = document.getElementById('currentAddBtn');
    var curPicker = document.getElementById('currentPicker');
    if (curAdd && curPicker && !curAdd.dataset.wired) {
        curAdd.dataset.wired = '1';
        curAdd.addEventListener('click', function () {
            curPicker.hidden = !curPicker.hidden;
            curAdd.textContent = curPicker.hidden ? 'Add a title' : 'Done adding';
            if (!curPicker.hidden) renderCurrentPicker();
        });
    }
    var curEdit = document.getElementById('currentEditBtn');
    var curDone = document.getElementById('currentDoneBtn');
    if (curEdit && !curEdit.dataset.wired) { curEdit.dataset.wired = '1'; curEdit.addEventListener('click', function () { setCurrentEditing(true); }); }
    if (curDone && !curDone.dataset.wired) { curDone.dataset.wired = '1'; curDone.addEventListener('click', function () { setCurrentEditing(false); }); }
}

/* Read-only display (both sections use it): a horizontal poster scroller, the
   same component the home dashboard rows are built from. */
function mgShowcase(items, emptyMsg) {
    if (!items.length) return '<p class="pf-empty">' + mgEsc(emptyMsg) + '</p>';
    return '<div class="dash-scroller">' + items.map(function (it) {
        var ref = it.game_id || it.ref || mgRef(it);
        var img = it.background_image || it.img || MG_FALLBACK;
        return '<a class="dash-card" href="title.html?ref=' + encodeURIComponent(ref) + '" title="' + mgEsc(it.name) + '">' +
            '<div class="dash-card-poster"><img src="' + mgEsc(img) + '" alt="' + mgEsc(it.name) + '" loading="lazy" onerror="this.src=\'' + MG_FALLBACK + '\'"></div>' +
            '<span class="dash-card-name">' + mgEsc(it.name) + '</span>' +
        '</a>';
    }).join('') + '</div>';
}

/* Drag-to-reorder, keyed by ref so it works whether the backing array holds
   objects (Top 10) or plain refs (Currently into) and regardless of filtering. */
function mgReorderByRef(arr, refOf, fromRef, toRef) {
    var from = arr.findIndex(function (x) { return String(refOf(x)) === String(fromRef); });
    if (from < 0) return;
    var moved = arr.splice(from, 1)[0];
    var to = arr.findIndex(function (x) { return String(refOf(x)) === String(toRef); });
    if (to < 0) { arr.push(moved); return; }
    arr.splice(to, 0, moved);
}

function mgDragList(listEl, arr, refOf, onDone) {
    var dragRef = null;
    listEl.querySelectorAll('.pf-edit-row').forEach(function (row) {
        row.setAttribute('draggable', 'true');
        row.addEventListener('dragstart', function (e) {
            dragRef = row.dataset.ref; row.classList.add('pf-dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', dragRef); } catch (_) {}
        });
        row.addEventListener('dragend', function () {
            row.classList.remove('pf-dragging');
            listEl.querySelectorAll('.pf-drop-target').forEach(function (r) { r.classList.remove('pf-drop-target'); });
        });
        row.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('pf-drop-target'); });
        row.addEventListener('dragleave', function () { row.classList.remove('pf-drop-target'); });
        row.addEventListener('drop', function (e) {
            e.preventDefault(); row.classList.remove('pf-drop-target');
            var toRef = row.dataset.ref;
            if (!dragRef || dragRef === toRef) return;
            mgReorderByRef(arr, refOf, dragRef, toRef);
            dragRef = null;
            onDone();
        });
    });
}

async function loadTopMedia() {
    try {
        var r = await fetch(API_BASE + '/user/profile/top', { headers: { Authorization: 'Bearer ' + authToken } });
        if (!r.ok) return;
        var d = await r.json();
        mgTop = d.top || mgTop;
        renderTop();
    } catch (_) { /* the section stays empty rather than blocking the page */ }
}

function renderTop() {
    var wrap = document.getElementById('topManager');
    if (wrap) wrap.setAttribute('data-accent', mgActiveCat);
    renderTopTabs();
    var items = mgTop[mgActiveCat] || [];
    var sc = document.getElementById('topShowcase');
    if (sc) {
        sc.innerHTML = mgShowcase(items, 'Nothing ranked in ' + MG_LABEL[mgActiveCat].toLowerCase() + ' yet. Hit Edit to add some.');
        if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(sc);
    }
    if (topEditing) renderTopEditList();
}

function renderTopTabs() {
    var tabs = document.getElementById('topCatTabs');
    if (!tabs) return;
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
            renderTop();
            var picker = document.getElementById('topPicker');
            if (topEditing && picker && !picker.hidden) renderPicker(document.getElementById('topPickerSearch').value);
        });
    });
}

function renderTopEditList() {
    var list = document.getElementById('topEditList');
    if (!list) return;
    var items = mgTop[mgActiveCat] || [];
    if (!items.length) {
        list.innerHTML = '<p class="pf-empty">Nothing here yet. Use “Add a title” to rank up to ten.</p>';
        return;
    }
    list.innerHTML = items.map(function (it, i) {
        return '<div class="pf-edit-row" data-ref="' + mgEsc(it.game_id) + '">' +
            '<span class="pf-drag-handle" aria-hidden="true">⠿</span>' +
            '<span class="pf-edit-pos">' + (i + 1) + '</span>' +
            mgPoster(it.background_image, '') +
            '<span class="pf-edit-name">' + mgEsc(it.name) + '</span>' +
            '<span class="pf-edit-actions">' +
                '<button type="button" class="pf-icon-btn" data-remove="' + mgEsc(it.game_id) + '" aria-label="Remove ' + mgEsc(it.name) + '">×</button>' +
            '</span>' +
        '</div>';
    }).join('');

    mgDragList(list, mgTop[mgActiveCat], function (it) { return it.game_id; }, function () { renderTop(); saveTop(); });
    list.querySelectorAll('[data-remove]').forEach(function (b) {
        b.addEventListener('click', function () {
            var arr = mgTop[mgActiveCat];
            var i = arr.findIndex(function (x) { return String(x.game_id) === String(b.dataset.remove); });
            if (i >= 0) arr.splice(i, 1);
            renderTop(); saveTop();
            var picker = document.getElementById('topPicker');
            if (picker && !picker.hidden) renderPicker(document.getElementById('topPickerSearch').value);
        });
    });
}

function setTopEditing(on) {
    topEditing = on;
    var wrap = document.getElementById('topEditWrap');
    var sc = document.getElementById('topShowcase');
    if (wrap) wrap.hidden = !on;
    if (sc) sc.hidden = on;
    document.getElementById('topEditBtn').style.display = on ? 'none' : '';
    document.getElementById('topDoneBtn').style.display = on ? '' : 'none';
    if (on) { renderTopEditList(); }
    else {
        var p = document.getElementById('topPicker'); if (p) p.hidden = true;
        var a = document.getElementById('topAddBtn'); if (a) a.textContent = 'Add a title';
        mgStatus('topStatus', '');
        renderTop();
    }
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
            renderTop();
            renderPicker(document.getElementById('topPickerSearch').value);
            saveTop();
        });
    });
}

async function saveTop() {
    var cat = mgActiveCat;
    var refs = (mgTop[cat] || []).map(function (t) { return t.game_id; });
    mgStatus('topStatus', 'Saving…');
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

/* ── Currently into ───────────────────────────────────────────────────────
   Mirrors Top 10: category tabs (with an "All"), a read-only poster showcase,
   and an edit mode with drag-to-reorder, remove, and an add picker - no ticks. */

var MG_CURRENT_CATS = ['all', 'movie', 'series', 'anime', 'game'];
var MG_CURRENT_LABEL = { all: 'All', movie: 'Movies', series: 'Shows', anime: 'Anime', game: 'Games' };

function mgPlaying() {
    return mgLibrary.filter(function (g) { return g.status === 'playing'; });
}

// Resolve the pinned refs back to library rows, in the pinned order.
function mgPinnedItems() {
    var byRef = {};
    mgLibrary.forEach(function (g) { byRef[mgRef(g)] = g; });
    return mgCurrentPinned.map(function (r) { return byRef[r]; }).filter(Boolean);
}

// What the profile actually shows: the pins if any, otherwise the most recent
// in-progress titles (the auto-follow behaviour). Filtered by the active tab.
function mgCurrentShowcaseItems() {
    var base = mgCurrentPinned.length ? mgPinnedItems() : mgPlaying();
    if (mgCurrentCat !== 'all') base = base.filter(function (g) { return (g.media_type || 'game') === mgCurrentCat; });
    return base;
}

function renderCurrent() {
    var wrap = document.getElementById('currentManager');
    if (wrap) wrap.setAttribute('data-accent', mgCurrentCat === 'all' ? 'movie' : mgCurrentCat);
    renderCurrentTabs();
    var sc = document.getElementById('currentShowcase');
    if (sc) {
        sc.innerHTML = mgShowcase(mgCurrentShowcaseItems(), mgCurrentPinned.length
            ? 'Nothing pinned in this category.'
            : 'Nothing in progress right now. Set something to “In progress” and it shows up here.');
        if (typeof window.enhanceScrollers === 'function') window.enhanceScrollers(sc);
    }
    if (currentEditing) renderCurrentEditList();
}

function renderCurrentTabs() {
    var tabs = document.getElementById('currentCatTabs');
    if (!tabs) return;
    tabs.innerHTML = MG_CURRENT_CATS.map(function (cat) {
        var on = cat === mgCurrentCat;
        return '<button type="button" role="tab" class="pf-chip' + (on ? ' active' : '') + '" data-cat="' + cat + '"' +
            ' aria-selected="' + on + '">' + MG_CURRENT_LABEL[cat] + '</button>';
    }).join('');
    tabs.querySelectorAll('.pf-chip').forEach(function (b) {
        b.addEventListener('click', function () {
            mgCurrentCat = b.dataset.cat;
            mgStatus('currentStatus', '');
            renderCurrent();
            var picker = document.getElementById('currentPicker');
            if (currentEditing && picker && !picker.hidden) renderCurrentPicker();
        });
    });
}

function renderCurrentEditList() {
    var list = document.getElementById('currentPickList');
    if (!list) return;
    var byRef = {};
    mgLibrary.forEach(function (g) { byRef[mgRef(g)] = g; });
    var pins = mgCurrentPinned.map(function (r) {
        var g = byRef[r];
        return g ? { ref: r, name: g.name, img: g.background_image, mt: g.media_type || 'game' } : null;
    }).filter(Boolean);
    var visible = mgCurrentCat === 'all' ? pins : pins.filter(function (p) { return p.mt === mgCurrentCat; });

    if (!visible.length) {
        list.innerHTML = '<p class="pf-empty">Nothing pinned' +
            (mgCurrentCat !== 'all' ? (' in ' + MG_CURRENT_LABEL[mgCurrentCat].toLowerCase()) : '') +
            ' yet. Use “Add a title” to pin what you are into.</p>';
        return;
    }

    list.innerHTML = visible.map(function (p) {
        return '<div class="pf-edit-row" data-ref="' + mgEsc(p.ref) + '">' +
            '<span class="pf-drag-handle" aria-hidden="true">⠿</span>' +
            mgPoster(p.img, '') +
            '<span class="pf-edit-name">' + mgEsc(p.name) + '</span>' +
            '<span class="pf-edit-actions">' +
                '<button type="button" class="pf-icon-btn" data-remove="' + mgEsc(p.ref) + '" aria-label="Unpin ' + mgEsc(p.name) + '">×</button>' +
            '</span>' +
        '</div>';
    }).join('');

    mgDragList(list, mgCurrentPinned, function (r) { return r; }, function () { renderCurrent(); saveCurrent(); });
    list.querySelectorAll('[data-remove]').forEach(function (b) {
        b.addEventListener('click', function () {
            var i = mgCurrentPinned.indexOf(b.dataset.remove);
            if (i >= 0) mgCurrentPinned.splice(i, 1);
            renderCurrent(); saveCurrent();
            var picker = document.getElementById('currentPicker');
            if (picker && !picker.hidden) renderCurrentPicker();
        });
    });
}

function renderCurrentPicker() {
    var out = document.getElementById('currentPickerResults');
    if (!out) return;
    var matches = mgPlaying().filter(function (g) {
        if (mgCurrentPinned.indexOf(mgRef(g)) !== -1) return false;
        if (mgCurrentCat !== 'all' && (g.media_type || 'game') !== mgCurrentCat) return false;
        return true;
    }).slice(0, 40);

    if (!matches.length) {
        out.innerHTML = '<p class="pf-empty">Nothing else in progress' +
            (mgCurrentCat !== 'all' ? (' in ' + MG_CURRENT_LABEL[mgCurrentCat].toLowerCase()) : '') + '.</p>';
        return;
    }

    var full = mgCurrentPinned.length >= MG_CURRENT_MAX;
    out.innerHTML = matches.map(function (g) {
        return '<button type="button" class="pf-picker-row" data-ref="' + mgEsc(mgRef(g)) + '"' +
            (full ? ' aria-disabled="true"' : '') + '>' +
            mgPoster(g.background_image, '') +
            '<span class="pf-edit-name">' + mgEsc(g.name) + '</span>' +
        '</button>';
    }).join('');

    out.querySelectorAll('.pf-picker-row').forEach(function (b) {
        b.addEventListener('click', function () {
            if (mgCurrentPinned.length >= MG_CURRENT_MAX) {
                mgStatus('currentStatus', 'You can pin at most ' + MG_CURRENT_MAX + '. Remove one first.', true);
                return;
            }
            mgCurrentPinned.push(b.dataset.ref);
            renderCurrent();
            renderCurrentPicker();
            saveCurrent();
        });
    });
}

function setCurrentEditing(on) {
    currentEditing = on;
    var wrap = document.getElementById('currentEditWrap');
    var sc = document.getElementById('currentShowcase');
    if (wrap) wrap.hidden = !on;
    if (sc) sc.hidden = on;
    document.getElementById('currentEditBtn').style.display = on ? 'none' : '';
    document.getElementById('currentDoneBtn').style.display = on ? '' : 'none';
    if (on) { renderCurrentEditList(); }
    else {
        var p = document.getElementById('currentPicker'); if (p) p.hidden = true;
        var a = document.getElementById('currentAddBtn'); if (a) a.textContent = 'Add a title';
        mgStatus('currentStatus', '');
        renderCurrent();
    }
}

async function saveCurrent() {
    mgStatus('currentStatus', 'Saving…');
    try {
        var r = await fetch(API_BASE + '/user/profile/current', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
            body: JSON.stringify({ game_ids: mgCurrentPinned })
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) { mgStatus('currentStatus', d.error || 'Could not save.', true); return; }
        mgStatus('currentStatus', mgCurrentPinned.length ? 'Saved' : 'Cleared - your profile follows what you touched most recently');
        setTimeout(function () { mgStatus('currentStatus', ''); }, 2400);
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
