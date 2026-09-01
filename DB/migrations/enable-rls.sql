-- Enable Row Level Security on every public table.
--
-- Why: these tables are exposed through Supabase's auto-generated PostgREST API to
-- anyone holding the public anon key (which ships to the browser). With RLS disabled
-- they are readable/writable directly, bypassing the Express API. The Supabase security
-- advisor flags this as "rls_disabled_in_public".
--
-- Safe because: the backend connects as the `postgres` owner over DATABASE_URL and the
-- table owner bypasses RLS (we use ENABLE, not FORCE), so the API keeps full access.
-- The frontend never queries these tables directly (it uses the Supabase client for
-- auth only), so denying anon/authenticated has no effect on the app.
--
-- Result: with RLS enabled and no policies, anon/authenticated get deny-all over PostgREST.
-- Apply in the Supabase SQL editor (or via `apply_migration`) once the project is active.

ALTER TABLE public.users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.games              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_game_lists    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_lists       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_list_games  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_follows       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ban_history        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderator_activity ENABLE ROW LEVEL SECURITY;
