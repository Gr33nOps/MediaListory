/**
 * Ensure a public.users row exists for a Supabase Auth user.
 * Username uniqueness is enforced by the DB (case-insensitive unique index).
 */

function sanitizeUsernameBase(preferred) {
  const base = String(preferred || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  if (!base) return 'user';
  return base.length < 3 ? `user_${base}` : base;
}

async function allocateUsername(db, preferred, excludeUserId = null) {
  const root = sanitizeUsernameBase(preferred);
  let candidate = root.slice(0, 50);
  let n = 0;
  while (await isUsernameTaken(db, candidate, excludeUserId)) {
    n += 1;
    const suffix = `_${n}`;
    candidate = `${root.slice(0, Math.max(1, 50 - suffix.length))}${suffix}`;
    if (n > 200) {
      candidate = `user_${Date.now().toString(36)}`.slice(0, 50);
      break;
    }
  }
  return candidate;
}

function pickAvatarUrl(meta = {}, extra = {}) {
  return (
    extra.avatar_url ||
    meta.avatar_url ||
    meta.picture ||
    meta.avatar ||
    null
  );
}

async function ensureLocalUser(db, sbUser, extra = {}) {
  if (!sbUser?.id) throw new Error('ensureLocalUser requires an auth user');

  // Neon Auth users are flat ({ id, email, name, image }); keep back-compat with
  // any object that still carries user_metadata.
  const meta = sbUser.user_metadata || {};
  const identityName = sbUser.name || meta.full_name || meta.name || meta.display_name;
  const identityAvatar = sbUser.image || meta.avatar_url || meta.picture || meta.avatar || null;

  let username =
    (extra.username || meta.username || meta.preferred_username || meta.user_name ||
      (sbUser.email || '').split('@')[0] || 'user')
      .trim()
      .slice(0, 50);

  const existing = await db('users').where({ id: sbUser.id }).first();
  if (existing) {
    const patch = {};
    if (!existing.auth_id) patch.auth_id = sbUser.id;
    if (!existing.email && sbUser.email) patch.email = sbUser.email;
    if (!existing.display_name && (extra.display_name || identityName)) {
      patch.display_name = extra.display_name || identityName;
    }
    const avatar = extra.avatar_url || identityAvatar;
    if (!existing.avatar_url && avatar) patch.avatar_url = avatar;
    if (Object.keys(patch).length) {
      await db('users').where({ id: sbUser.id }).update(patch);
      return { ...existing, ...patch };
    }
    return existing;
  }

  if (!extra.username && await isUsernameTaken(db, username)) {
    username = await allocateUsername(db, username);
  }

  const {
    username: _ignoreUsername,
    id: _ignoreId,
    ...safeExtra
  } = extra;

  const row = {
    id: sbUser.id,
    auth_id: sbUser.id,
    username,
    email: sbUser.email || null,
    display_name: (extra.display_name || identityName || username || '').slice(0, 100),
    avatar_url: extra.avatar_url || identityAvatar,
    is_admin: false,
    is_moderator: false,
    is_banned: false,
    ...safeExtra,
    id: sbUser.id,
    username
  };

  try {
    await db('users').insert(row);
  } catch (err) {
    // Concurrent insert of same id
    const again = await db('users').where({ id: sbUser.id }).first();
    if (again) return again;
    // Username race - retry once with a fresh unique name
    if (err && (err.code === '23505' || /unique|duplicate/i.test(err.message || ''))) {
      const retryName = await allocateUsername(db, username);
      await db('users').insert({ ...row, username: retryName });
      return db('users').where({ id: sbUser.id }).first();
    }
    err.code = err.code || 'LOCAL_USER_INSERT_FAILED';
    throw err;
  }

  return db('users').where({ id: sbUser.id }).first();
}

async function findUserByUsername(db, username) {
  if (!username) return null;
  return db('users')
    .whereRaw('LOWER(username) = LOWER(?)', [String(username).trim()])
    .first();
}

async function isUsernameTaken(db, username, excludeUserId = null) {
  let q = db('users').whereRaw('LOWER(username) = LOWER(?)', [String(username).trim()]);
  if (excludeUserId) q = q.whereNot({ id: excludeUserId });
  const row = await q.first('id');
  return !!row;
}

module.exports = {
  ensureLocalUser,
  findUserByUsername,
  isUsernameTaken,
  allocateUsername,
  sanitizeUsernameBase
};
