// FIXED: relative path - works on any host, not just localhost
const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '/api';

let authToken   = localStorage.getItem('authToken');
let currentUser = (typeof getStoredUser === 'function') ? getStoredUser() : null;

(async function bootFriends() {
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
        const r = await fetch(`${API_BASE}/auth/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (r.ok) {
            const d = await r.json();
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
    document.getElementById('searchUsersBtn').addEventListener('click', searchUsers);

    document.getElementById('userSearchInput').addEventListener('keypress', e => {
        if (e.key === 'Enter') searchUsers();
    });

    document.getElementById('followingList').addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action="focus-search"]');
        if (!btn) return;
        var input = document.getElementById('userSearchInput');
        if (input) {
            input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            input.focus({ preventScroll: true });
            input.classList.add('input-flash');
            setTimeout(function () { input.classList.remove('input-flash'); }, 1000);
        }
    });

    loadFollowing();
}

// ══════════════════════════════════════════════════════════════════════════
// FOLLOWING LIST
// ══════════════════════════════════════════════════════════════════════════
async function loadFollowing() {
    try {
        const r = await fetch(`${API_BASE}/following`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) {
            const d = await r.json();
            displayFollowing(d.following);
        }
    } catch (e) {
        console.error('Load following error:', e);
    }
}

function displayFollowing(following) {
    const container = document.getElementById('followingList');
    const count     = document.getElementById('followingCount');

    count.textContent = `${following.length} following`;

    if (following.length === 0) {
        container.innerHTML = '<div class="empty-state">' +
            '<p>You are not following anyone yet.</p>' +
            '<p>Search for someone below and follow them to see their profile and library here.</p>' +
            '<button type="button" class="btn btn-primary" style="margin-top:14px;" data-action="focus-search">Find people</button>' +
            '</div>';
        return;
    }

    container.innerHTML = following.map(user => renderUserCard(user, {
        showFollowedSince: true,
        isFollowing: true
    })).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// USER SEARCH
// ══════════════════════════════════════════════════════════════════════════
async function searchUsers() {
    const query = document.getElementById('userSearchInput').value.trim();

    if (query.length < 2) {
        document.getElementById('searchResults').classList.add('hidden');
        return;
    }

    const container = document.getElementById('userSearchResults');
    const section   = document.getElementById('searchResults');

    section.classList.remove('hidden');
    container.innerHTML = '<div class="empty-state">Searching…</div>';

    try {
        const r = await fetch(`${API_BASE}/users/search?query=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (!r.ok) throw new Error('Search failed');

        const d = await r.json();
        await displaySearchResults(d.users);
    } catch (e) {
        console.error('Search users error:', e);
        container.innerHTML = '<div class="empty-state">Error loading search results. Please try again.</div>';
    }
}

async function displaySearchResults(users) {
    const container = document.getElementById('userSearchResults');

    if (users.length === 0) {
        container.innerHTML = '<div class="empty-state">No users found.</div>';
        return;
    }

    // Fetch follow status for all results in parallel
    const statuses = await Promise.all(
        users.map(u => checkFollowStatus(u.id).catch(() => ({ isFollowing: false, followsYou: false })))
    );

    container.innerHTML = users.map((user, i) => renderUserCard(user, {
        showFollowedSince: false,
        isFollowing:  statuses[i].isFollowing,
        followsYou:   statuses[i].followsYou
    })).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// SHARED CARD RENDERER
// Uses data-* attributes + event delegation - safe with UUID user IDs
// ══════════════════════════════════════════════════════════════════════════
function renderUserCard(user, { showFollowedSince = false, isFollowing = false, followsYou = false } = {}) {
    const avatarUrl = user.avatar_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(user.display_name || user.username)}&size=80&background=3b82f6&color=fff&bold=true`;

    const followedSinceHtml = showFollowedSince && user.followed_since
        ? `<div class="friend-since">Following since ${new Date(user.followed_since).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })}</div>`
        : '';

    const followsYouBadge = followsYou
        ? `<span class="badge" style="background:#10b981;color:white;padding:2px 8px;border-radius:12px;font-size:12px;margin-left:8px;">Follows you</span>`
        : '';

    // FIXED: use data-user-id attribute instead of inline onclick with UUID arg
    const followBtn = isFollowing
        ? `<button class="btn btn-danger"  data-action="unfollow" data-user-id="${user.id}">Unfollow</button>`
        : `<button class="btn btn-success" data-action="follow"   data-user-id="${user.id}">Follow</button>`;

    return `
        <div class="friend-item" data-user-id="${user.id}">
            <img src="${avatarUrl}"
                 alt="${esc(user.display_name || user.username)}"
                 class="friend-avatar"
                 onerror="this.src='https://ui-avatars.com/api/?name=User&size=80&background=3b82f6&color=fff&bold=true'">
            <div class="friend-info">
                <div class="friend-name">${esc(user.display_name || user.username)}${followsYouBadge}</div>
                <div class="friend-username">@${esc(user.username)}</div>
                ${followedSinceHtml}
            </div>
            <div class="friend-actions">
                <button class="btn btn-primary" data-action="view-profile" data-user-id="${user.id}">View Profile</button>
                ${followBtn}
            </div>
        </div>`;
}

// ── Single delegated listener for all card buttons ───────────────────────
document.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const userId = btn.dataset.userId;

    if (action === 'view-profile') viewProfile(userId);
    if (action === 'follow')       await handleFollow(userId);
    if (action === 'unfollow')     await handleUnfollow(userId);
});

// ══════════════════════════════════════════════════════════════════════════
// FOLLOW / UNFOLLOW ACTIONS
// ══════════════════════════════════════════════════════════════════════════
async function checkFollowStatus(userId) {
    const r = await fetch(`${API_BASE}/follow/status/${userId}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (r.ok) return r.json();
    return { isFollowing: false, followsYou: false };
}

async function handleFollow(userId) {
    try {
        const r = await fetch(`${API_BASE}/follow/${userId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (r.ok) {
            await refreshAfterAction();
        } else {
            const d = await r.json();
            if (typeof toast === 'function') toast(d.error || 'Failed to follow user', 'error');
            else notify(d.error || 'Failed to follow user');
        }
    } catch (e) {
        console.error('Follow error:', e);
        if (typeof toast === 'function') toast('Failed to follow user. Please try again.', 'error');
        else notify('Failed to follow user. Please try again.');
    }
}

async function handleUnfollow(userId) {
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
        const r = await fetch(`${API_BASE}/follow/${userId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (r.ok) {
            await refreshAfterAction();
        } else {
            const d = await r.json();
            if (typeof toast === 'function') toast(d.error || 'Failed to unfollow user', 'error');
            else notify(d.error || 'Failed to unfollow user');
        }
    } catch (e) {
        console.error('Unfollow error:', e);
        if (typeof toast === 'function') toast('Failed to unfollow user. Please try again.', 'error');
        else notify('Failed to unfollow user. Please try again.');
    }
}

// Refresh both the following list and search results after a follow/unfollow
async function refreshAfterAction() {
    await loadFollowing();
    const searchInput = document.getElementById('userSearchInput');
    if (searchInput.value.trim().length >= 2) {
        await searchUsers();
    }
}

// ══════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════════════════════
function viewProfile(userId) {
    // userId is a UUID string - passes through safely in the URL
    window.location.href = `userProfile.html?userId=${userId}`;
}

// ══════════════════════════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════════════════════════
function logout() {
    if (typeof logoutToAuth === 'function') logoutToAuth();
    else {
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        window.location.href = 'auth.html';
    }
}

window.logout = logout;