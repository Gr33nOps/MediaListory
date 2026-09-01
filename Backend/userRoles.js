/**
 * Keep public.users role/ban flags updated. public.users is the source of truth
 * that middleware (checkBanned / verifyAdmin / verifyModerator) trusts. The identity
 * provider (Neon Auth) is not consulted here.
 *
 * Signature keeps a placeholder second arg for backward compatibility with existing
 * call sites; it is ignored.
 */

async function syncUserFlags(db, _unused, userId, flags) {
  const keys = [
    'is_banned',
    'banned_at',
    'banned_by',
    'ban_reason',
    'is_moderator',
    'is_admin'
  ];

  const dbPatch = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      dbPatch[key] = flags[key];
    }
  }

  const user = await db('users').where({ id: userId }).first();
  if (!user) throw new Error('User not found');

  if (Object.keys(dbPatch).length > 0) {
    await db('users').where({ id: userId }).update(dbPatch);
  }

  return user;
}

module.exports = { syncUserFlags };
