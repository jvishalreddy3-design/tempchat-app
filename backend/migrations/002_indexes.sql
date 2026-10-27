-- Migration 002: Indexes for TempChat PostgreSQL schema
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/002_indexes.sql

-- Users indexes (unique constraints already created in 001)
CREATE INDEX IF NOT EXISTS users_username_unique ON users(username);
CREATE INDEX IF NOT EXISTS users_username_key_unique ON users(username_key);

-- Auth sessions indexes
CREATE INDEX IF NOT EXISTS auth_sessions_refresh_hash_unique ON auth_sessions(refresh_hash);
CREATE INDEX IF NOT EXISTS auth_sessions_user_active ON auth_sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS auth_sessions_ttl ON auth_sessions(expires_at);

-- Friend requests indexes
CREATE INDEX IF NOT EXISTS friend_requests_pair_key_pending ON friend_requests(pair_key) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS friend_requests_inbox ON friend_requests(recipient_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS friend_requests_outbox ON friend_requests(sender_id, state, created_at DESC);

-- Friendships indexes
CREATE INDEX IF NOT EXISTS friendships_pair_unique ON friendships(pair_key);
CREATE INDEX IF NOT EXISTS friendships_by_user ON friendships USING GIN(user_ids);

-- Private conversations indexes
CREATE INDEX IF NOT EXISTS private_conversation_pair_unique ON private_conversations(pair_key);
CREATE INDEX IF NOT EXISTS private_conversations_by_user ON private_conversations USING GIN(user_ids);

-- Private messages indexes
CREATE INDEX IF NOT EXISTS private_messages_by_conversation ON private_messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS private_messages_by_sender ON private_messages(from_id, created_at DESC);
CREATE INDEX IF NOT EXISTS private_messages_delivery ON private_messages USING GIN(delivered_to);

-- Record migration
INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT (version) DO NOTHING;
