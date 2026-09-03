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
        exportBtn.addEventListener('click', exportMyData);
    }

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
}

// Read a chosen image, cover-crop to a square, downscale, and return a small
// JPEG data URL so any photo from the user's device becomes a light avatar.
function readImageToDataUrl(file, cb) {
    if (!file || !/^image\//.test(file.type)) { cb(null); return; }
    var reader = new FileReader();
    reader.onload = function () {
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
        img.src = reader.result;
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
        readImageToDataUrl(file, function (url) {
            if (!url) { flashEdit('Could not read that image. Try a JPG or PNG.', true); return; }
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
            return '<a class="cat-stat" data-cat="' + o[0] + '" href="myGameList.html" title="View your ' + o[1] + '">' +
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
            body: JSON.stringify({ display_name: displayName, email: email, avatar_url: avatarUrl, is_private: isPrivate })
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

async function exportMyData() {
    try {
        var r = await fetch((typeof API_BASE !== 'undefined' ? API_BASE : '/api') + '/user/export', {
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
        a.download = 'medialistory-export.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        if (typeof toast === 'function') toast('Export downloaded', 'success');
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