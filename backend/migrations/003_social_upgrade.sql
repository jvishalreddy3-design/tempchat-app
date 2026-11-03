-- Migration 003: social upgrade (last seen + defense-in-depth RLS)
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/003_social_upgrade.sql
--
-- TempChat private messages are now ephemeral and are never written to
-- PostgreSQL. The legacy private_messages/private_conversations tables are
-- intentionally left in place (do not drop existing tables) but are unused.

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NULL;
CREATE INDEX IF NOT EXISTS users_last_seen ON users(last_seen_at DESC);

-- All application access goes through the Render backend using the database
-- owner role. Enabling RLS without permissive policies denies direct access
-- from Supabase anon/authenticated clients while the owner (backend) bypasses
-- RLS. This is defense in depth, not a replacement for backend authorization.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_messages ENABLE ROW LEVEL SECURITY;
