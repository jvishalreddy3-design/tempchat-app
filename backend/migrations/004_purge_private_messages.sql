-- Migration 004: one-time privacy purge (OPTIONAL / MANUAL)
--
-- Run this ONCE only if you want to erase private messages that were stored by
-- older TempChat versions before the switch to ephemeral messaging:
--
--   psql "$DATABASE_URL" -f backend/migrations/004_purge_private_messages.sql
--
-- This does NOT drop tables. The current application no longer reads or writes
-- these tables, so after this purge no chat content remains in PostgreSQL.
--
-- Back up first if you need to retain anything. This is irreversible.

BEGIN;
DELETE FROM private_messages;
DELETE FROM private_conversations;
COMMIT;
