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

    var avatarInput = document.getElementById('editAvatarUrl');
    if (avatarInput) {
        avatarInput.addEventListener('input', function(e) {
            var preview = document.getElementById('editAvatarPreview');
            if (preview && e.target.value) preview.src = e.target.value;
        });
    }

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
    document.getElementById('editAvatarUrl').value         = user.avatar_url || '';
}

function displayStats(games, followers, following) {
    var totalGames = games.length;
    document.getElementById('userLevel').textContent      = calculateLevel(totalGames);
    document.getElementById('totalGames').textContent     = totalGames;
    document.getElementById('followersCount').textContent = followers.length;
    document.getElementById('followingCount').textContent = following.length;

    var breakdown = { game: 0, movie: 0, series: 0 };
    games.forEach(function(g) {
        var t = g.media_type || 'game';
        if (breakdown[t] === undefined) breakdown[t] = 0;
        breakdown[t]++;
    });
    var el = document.getElementById('mediaBreakdown');
    if (el) el.textContent = breakdown.game + ' games · ' + breakdown.movie + ' movies · ' + breakdown.series + ' series';
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
    var avatarUrl   = document.getElementById('editAvatarUrl').value;

    try {
        var response = await fetch(`${API_BASE}/user/profile`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ display_name: displayName, email: email, avatar_url: avatarUrl || null })
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