-- Account privacy + follow requests.
-- Public accounts allow direct follows and appear in People discovery.
-- Private accounts require an accepted follow request before their library is visible.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS user_follow_requests (
  id           bigserial PRIMARY KEY,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requester_id, target_id)
);

CREATE INDEX IF NOT EXISTS ufr_target_idx ON user_follow_requests (target_id);
