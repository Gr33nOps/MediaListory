-- Map local users to an external identity provider (Neon Auth / Better Auth).
-- The app keeps its own UUID `users.id` as the primary key (all FKs unchanged);
-- `auth_id` stores the provider's user id and is the lookup key at login/OAuth.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_auth_id_uidx
  ON public.users (auth_id) WHERE auth_id IS NOT NULL;
