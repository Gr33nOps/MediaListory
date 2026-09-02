const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '/api';

let authToken   = localStorage.getItem('authToken');
let currentUser = (typeof getStoredUser === 'function') ? getStoredUser() : null;

(async function bootFriends() {
    if (typeof ensureSession === 'function') { try { await ensureSession(); } catch (_) {} }
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
            headers: { 'Authorization': `Bearer ${authToken}` }, credentials: 'same-origin', cache: 'no-store'
        });
        if (r.ok) {
            const d = await r.json();
            currentUser = d.user;
            localStorage.setItem('currentUser', JSON.stringify(d.user));
            initPage();
        } else if (r.status === 401 || r.status === 403) { logout(); }
        else if (currentUser) { initPage(); }
    } catch (e) { console.error('Verify token error:', e); if (currentUser) initPage(); }
}

function initPage() {
    document.getElementById('searchUsersBtn').addEventListener('click', searchUsers);
    document.getElementById('userSearchInput').addEventListener('keypress', e => { if (e.key === 'Enter') searchUsers(); });
    loadFollowing();
    loadRequests();
    loadDiscover();
    loadActivity();
}

const PAGE_FOR_MEDIA = { movie: 'movies.html', series: 'series.html', anime: 'anime.html', game: 'home.html' };

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const then = new Date(dateStr).getTime();
    if (!Number.isFinite(then)) return '';
    const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
    const w = Math.floor(d / 7); if (w < 5) return w + 'w ago';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function avatarFor(user, size) {
    return user.avatar_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(user.display_name || user.username || 'User')}&size=${size || 80}&background=475569&color=fff&bold=true`;
}

// ── Activity feed ─────────────────────────────────────────────────────────
async function loadActivity() {
    try {
        const r = await fetch(`${API_BASE}/following/activity`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!r.ok) return;
        const d = await r.json();
        displayActivity(d.activity || []);
    } catch (e) { console.error('Load activity error:', e); }
}

function displayActivity(items) {
    const section = document.getElementById('activitySection');
    const feed = document.getElementById('activityFeed');
    if (!section || !feed) return;
    if (!items.length) { section.hidden = true; return; }
    section.hidden = false;
    feed.innerHTML = items.map(a => {
        const name = a.user.display_name || a.user.username;
        const verb = (a.score != null)
            ? `rated <strong>${esc(a.media.name)}</strong> ${a.score}/10`
            : `finished <strong>${esc(a.media.name)}</strong>`;
        const page = PAGE_FOR_MEDIA[a.media.media_type] || 'home.html';
        const href = `${page}?open=${encodeURIComponent(a.media.media_ref || '')}`;
        const thumb = a.media.background_image
            ? `<img class="activity-thumb" src="${esc(a.media.background_image)}" alt="" loading="lazy">`
            : `<span class="activity-thumb activity-thumb-empty"></span>`;
        return `<a class="activity-item" href="${href}">
            <img class="activity-avatar" src="${avatarFor(a.user, 64)}" alt="" onerror="this.src='https://ui-avatars.com/api/?name=User&size=64&background=475569&color=fff&bold=true'">
            <span class="activity-text">
                <span class="activity-line"><span class="activity-user">${esc(name)}</span> ${verb}</span>
                <span class="activity-time">${timeAgo(a.updated_at)}</span>
            </span>${thumb}</a>`;
    }).join('');
}

// ── Following ─────────────────────────────────────────────────────────────
async function loadFollowing() {
    try {
        const r = await fetch(`${API_BASE}/following`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (r.ok) { const d = await r.json(); displayFollowing(d.following || []); }
    } catch (e) { console.error('Load following error:', e); }
}

function displayFollowing(following) {
    const section   = document.getElementById('followingSection');
    const container = document.getElementById('followingList');
    const count     = document.getElementById('followingCount');
    if (!following.length) { if (section) section.hidden = true; return; }
    if (section) section.hidden = false;
    count.textContent = `${following.length} following`;
    container.innerHTML = following.map(u => renderUserCard(u, { showFollowedSince: true })).join('');
}

// ── Follow requests (incoming) ────────────────────────────────────────────
async function loadRequests() {
    try {
        const r = await fetch(`${API_BASE}/follow/requests`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (r.ok) { const d = await r.json(); displayRequests(d.requests || []); }
    } catch (e) { console.error('Load requests error:', e); }
}

function displayRequests(reqs) {
    const section = document.getElementById('requestsSection');
    const list    = document.getElementById('requestsList');
    const count   = document.getElementById('requestsCount');
    if (!section || !list) return;
    if (!reqs.length) { section.hidden = true; return; }
    section.hidden = false;
    count.textContent = `${reqs.length} pending`;
    list.innerHTML = reqs.map(u => `
        <div class="friend-item" data-user-id="${u.id}">
            <img src="${avatarFor(u, 80)}" alt="" class="friend-avatar" onerror="this.src='https://ui-avatars.com/api/?name=User&size=80&background=475569&color=fff&bold=true'">
            <div class="friend-info">
                <div class="friend-name">${esc(u.display_name || u.username)}</div>
                <div class="friend-username">@${esc(u.username)} · wants to follow you</div>
            </div>
            <div class="friend-actions">
                <button class="btn btn-success" data-action="accept-request" data-user-id="${u.id}">Accept</button>
                <button class="btn btn-secondary" data-action="reject-request" data-user-id="${u.id}">Decline</button>
            </div>
        </div>`).join('');
}

// ── Discover people ───────────────────────────────────────────────────────
async function loadDiscover() {
    const list = document.getElementById('discoverList');
    if (list) list.innerHTML = '<div class="empty-state">Loading people…</div>';
    try {
        const r = await fetch(`${API_BASE}/discover`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (r.ok) { const d = await r.json(); displayDiscover(d.users || []); }
    } catch (e) { console.error('Load discover error:', e); }
}

function displayDiscover(users) {
    const list = document.getElementById('discoverList');
    if (!list) return;
    if (!users.length) {
        list.innerHTML = '<div class="empty-state"><p>No other members yet.</p><p>As people join, they will show up here to follow.</p></div>';
        return;
    }
    list.innerHTML = users.map(u => renderUserCard(u)).join('');
}

// ── User search ───────────────────────────────────────────────────────────
async function searchUsers() {
    const query = document.getElementById('userSearchInput').value.trim();
    const section = document.getElementById('searchResults');
    const container = document.getElementById('userSearchResults');
    if (query.length < 2) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    container.innerHTML = '<div class="empty-state">Searching…</div>';
    try {
        const r = await fetch(`${API_BASE}/users/search?query=${encodeURIComponent(query)}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!r.ok) throw new Error('Search failed');
        const d = await r.json();
        container.innerHTML = (d.users && d.users.length)
            ? d.users.map(u => renderUserCard(u)).join('')
            : '<div class="empty-state">No people found.</div>';
    } catch (e) {
        console.error('Search users error:', e);
        container.innerHTML = '<div class="empty-state">Could not search right now. Try again.</div>';
    }
}

// ── Shared card renderer (relationship-aware) ─────────────────────────────
function relBtn(user) {
    const rel = user.relationship || 'none';
    if (rel === 'following') return `<button class="btn btn-secondary" data-action="unfollow" data-user-id="${user.id}">Following</button>`;
    if (rel === 'requested') return `<button class="btn btn-secondary" data-action="cancel-request" data-user-id="${user.id}">Requested</button>`;
    return `<button class="btn btn-primary" data-action="follow" data-user-id="${user.id}">${user.is_private ? 'Request' : 'Follow'}</button>`;
}

function renderUserCard(user, { showFollowedSince = false } = {}) {
    const privateTag = user.is_private ? '<span class="friend-tag">Private</span>' : '';
    const followedSince = showFollowedSince && user.followed_since
        ? `<div class="friend-since">Following since ${new Date(user.followed_since).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })}</div>`
        : '';
    return `
        <div class="friend-item" data-user-id="${user.id}">
            <img src="${avatarFor(user, 80)}" alt="${esc(user.display_name || user.username)}" class="friend-avatar"
                 onerror="this.src='https://ui-avatars.com/api/?name=User&size=80&background=475569&color=fff&bold=true'">
            <div class="friend-info">
                <div class="friend-name">${esc(user.display_name || user.username)} ${privateTag}</div>
                <div class="friend-username">@${esc(user.username)}</div>
                ${followedSince}
            </div>
            <div class="friend-actions">
                <button class="btn btn-secondary" data-action="view-profile" data-user-id="${user.id}">View profile</button>
                ${relBtn(user)}
            </div>
        </div>`;
}

// ── Delegated actions ─────────────────────────────────────────────────────
document.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const userId = btn.dataset.userId;
    if (action === 'view-profile')   { viewProfile(userId); return; }
    if (action === 'follow')         { await handleFollow(userId, btn); return; }
    if (action === 'unfollow')       { await handleUnfollow(userId); return; }
    if (action === 'cancel-request') { await handleUnfollow(userId, true); return; }
    if (action === 'accept-request') { await handleRequest(userId, 'accept'); return; }
    if (action === 'reject-request') { await handleRequest(userId, 'reject'); return; }
});

async function handleFollow(userId, btn) {
    try {
        if (btn) btn.disabled = true;
        const r = await fetch(`${API_BASE}/follow/${userId}`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } });
        const d = await r.json().catch(() => ({}));
        if (r.ok) {
            if (d.status === 'requested' && typeof toast === 'function') toast('Follow request sent.', 'success');
            await refreshAll();
        } else {
            if (btn) btn.disabled = false;
            if (typeof toast === 'function') toast(d.error || 'Could not follow.', 'error');
        }
    } catch (e) { if (btn) btn.disabled = false; console.error('Follow error:', e); }
}

async function handleUnfollow(userId, isCancel) {
    const ok = typeof confirmAction === 'function'
        ? await confirmAction({ title: isCancel ? 'Cancel request' : 'Unfollow', message: isCancel ? 'Cancel your follow request?' : 'Unfollow this person?', confirmLabel: isCancel ? 'Cancel request' : 'Unfollow', danger: true })
        : window.confirm(isCancel ? 'Cancel your follow request?' : 'Unfollow this person?');
    if (!ok) return;
    try {
        const r = await fetch(`${API_BASE}/follow/${userId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } });
        if (r.ok) await refreshAll();
        else { const d = await r.json().catch(() => ({})); if (typeof toast === 'function') toast(d.error || 'Failed.', 'error'); }
    } catch (e) { console.error('Unfollow error:', e); }
}

async function handleRequest(userId, kind) {
    try {
        const r = await fetch(`${API_BASE}/follow/requests/${userId}/${kind}`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } });
        if (r.ok) { if (typeof toast === 'function') toast(kind === 'accept' ? 'Request accepted.' : 'Request declined.', 'success'); await refreshAll(); }
        else { const d = await r.json().catch(() => ({})); if (typeof toast === 'function') toast(d.error || 'Failed.', 'error'); }
    } catch (e) { console.error('Request action error:', e); }
}

async function refreshAll() {
    await Promise.all([loadFollowing(), loadRequests(), loadDiscover(), loadActivity()]);
    const searchInput = document.getElementById('userSearchInput');
    if (searchInput && searchInput.value.trim().length >= 2) await searchUsers();
}

function viewProfile(userId) { window.location.href = `userProfile.html?userId=${userId}`; }

function logout() {
    if (typeof logoutToAuth === 'function') logoutToAuth();
    else { localStorage.removeItem('authToken'); localStorage.removeItem('currentUser'); window.location.href = 'auth.html'; }
}
window.logout = logout;
