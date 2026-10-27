'use strict';

const { Pool } = require('pg');
const crypto = require('node:crypto');

function pgDebugEnabled() {
  return process.env.TEMPCHAT_PG_DEBUG === 'true';
}

function safePgErrorMessage(error) {
  return String(error?.message || 'Unknown PostgreSQL error');
}

function isValidPemCertificate(cert) {
  if (!cert || typeof cert !== 'string') return false;
  const trimmed = cert.trim();
  return trimmed.startsWith('-----BEGIN CERTIFICATE-----') && trimmed.endsWith('-----END CERTIFICATE-----');
}

function buildSslConfig(config) {
  if (config.pgSsl === 'false') {
    return false;
  }

  const caCert = config.pgCaCert || '';

  if (caCert) {
    if (!isValidPemCertificate(caCert)) {
      throw new Error(
        'Invalid SUPABASE_CA_CERT: expected a PEM-formatted certificate starting with "-----BEGIN CERTIFICATE-----" and ending with "-----END CERTIFICATE-----".'
      );
    }
    return { ca: caCert, rejectUnauthorized: true };
  }

  throw new Error(
    'Missing required environment variable: SUPABASE_CA_CERT. ' +
    'Provide the Supabase CA certificate to verify server TLS certificates. ' +
    'Set PG_SSL=false only if you intentionally want to disable SSL (not recommended for production).'
  );
}

// Pair key: sorted "smallerId:largerId" for friendships and friend requests.
function pairKey(a, b) {
  return [a, b].sort().join(':');
}

class PgStore {
  constructor(pool) {
    this.pool = pool;
  }

  static async connect(config) {
    const connectionString = config.databaseUrl || '';
    if (!connectionString) {
      throw new Error('Missing required environment variable: DATABASE_URL');
    }

    const sslConfig = buildSslConfig(config);

    const pool = new Pool({
      connectionString,
      ssl: sslConfig,
      max: 20,
      min: 0,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    if (pgDebugEnabled()) {
      console.info('[pg] connecting to Supabase PostgreSQL (uri redacted)');
    }

    // Verify connectivity with a simple query.
    await pool.query('SELECT 1');

    const store = new PgStore(pool);
    await store.ensureSchema();
    await store.ensureIndexes();
    return store;
  }

  async close() {
    await this.pool.end();
  }

  // ---------------------------------------------------------------------------
  // Schema setup
  // ---------------------------------------------------------------------------

  async ensureSchema() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username VARCHAR(24) NOT NULL UNIQUE,
          username_key VARCHAR(24) NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          google_sub TEXT DEFAULT NULL,
          display_name VARCHAR(48) NOT NULL,
          avatar_url TEXT DEFAULT NULL,
          email_verified BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS auth_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          refresh_hash TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ DEFAULT NULL,
          user_agent VARCHAR(256) DEFAULT NULL,
          replaced_by UUID DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS friend_requests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pair_key TEXT NOT NULL,
          sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          state VARCHAR(20) NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          responded_at TIMESTAMPTZ DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS friendships (
          pair_key TEXT PRIMARY KEY,
          user_ids UUID[] NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS private_conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pair_key TEXT NOT NULL UNIQUE,
          user_ids UUID[] NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS private_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          conversation_id UUID NOT NULL REFERENCES private_conversations(id) ON DELETE CASCADE,
          from_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          sender_name VARCHAR(48) NOT NULL,
          text TEXT NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          delivered_to UUID[] NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    } finally {
      client.release();
    }
  }

  async ensureIndexes() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS users_username_unique ON users(username);
        CREATE INDEX IF NOT EXISTS users_username_key_unique ON users(username_key);
        CREATE INDEX IF NOT EXISTS auth_sessions_refresh_hash_unique ON auth_sessions(refresh_hash);
        CREATE INDEX IF NOT EXISTS auth_sessions_user_active ON auth_sessions(user_id, revoked_at);
        CREATE INDEX IF NOT EXISTS auth_sessions_ttl ON auth_sessions(expires_at);
        CREATE INDEX IF NOT EXISTS friend_requests_pair_key_unique ON friend_requests(pair_key) WHERE state = 'pending';
        CREATE INDEX IF NOT EXISTS friend_requests_inbox ON friend_requests(recipient_id, state, created_at DESC);
        CREATE INDEX IF NOT EXISTS friend_requests_outbox ON friend_requests(sender_id, state, created_at DESC);
        CREATE INDEX IF NOT EXISTS friendships_pair_unique ON friendships(pair_key);
        CREATE INDEX IF NOT EXISTS friendships_by_user ON friendships USING GIN(user_ids);
        CREATE INDEX IF NOT EXISTS private_conversation_pair_unique ON private_conversations(pair_key);
        CREATE INDEX IF NOT EXISTS private_conversations_by_user ON private_conversations USING GIN(user_ids);
        CREATE INDEX IF NOT EXISTS private_messages_by_conversation ON private_messages(conversation_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS private_messages_by_sender ON private_messages(from_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS private_messages_delivery ON private_messages USING GIN(delivered_to);
      `);
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  async createUser(user) {
    const result = await this.pool.query(
      `INSERT INTO users (id, username, username_key, password_hash, google_sub, display_name, avatar_url, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        user._id || crypto.randomUUID(),
        user.username,
        user.usernameKey,
        user.passwordHash,
        user.googleSub ?? null,
        user.displayName,
        user.avatarUrl ?? null,
        user.emailVerified !== false,
        user.createdAt || new Date(),
        user.updatedAt || new Date(),
      ]
    );
    return this._rowToUser(result.rows[0]);
  }

  findUserById(id) {
    return this.pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [id]
    ).then((result) => result.rows[0] ? this._rowToUser(result.rows[0]) : null);
  }

  findUserByUsername(usernameKey) {
    return this.pool.query(
      `SELECT * FROM users WHERE username_key = $1`,
      [usernameKey]
    ).then((result) => result.rows[0] ? this._rowToUser(result.rows[0]) : null);
  }

  async searchUsers(query, limit = 20) {
    const result = await this.pool.query(
      `SELECT id, username, display_name, avatar_url FROM users
       WHERE username_key ILIKE $1
       LIMIT $2`,
      [`%${query}%`, limit]
    );
    return result.rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url || null,
    }));
  }

  async updateUser(id, update) {
    const sets = [];
    const values = [];
    let idx = 1;

    if (update.displayName !== undefined) {
      sets.push(`display_name = $${idx++}`);
      values.push(update.displayName);
    }
    if (update.avatarUrl !== undefined) {
      sets.push(`avatar_url = $${idx++}`);
      values.push(update.avatarUrl);
    }
    if (update.updatedAt !== undefined) {
      sets.push(`updated_at = $${idx++}`);
      values.push(update.updatedAt);
    }

    if (sets.length === 0) {
      return this.findUserById(id);
    }

    values.push(id);
    const result = await this.pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0] ? this._rowToUser(result.rows[0]) : null;
  }

  _rowToUser(row) {
    if (!row) return null;
    return {
      _id: row.id,
      id: row.id,
      username: row.username,
      usernameKey: row.username_key,
      passwordHash: row.password_hash,
      googleSub: row.google_sub,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      emailVerified: row.email_verified,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async createSession(session) {
    await this.pool.query(
      `INSERT INTO auth_sessions (id, user_id, refresh_hash, created_at, expires_at, revoked_at, user_agent, replaced_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        session._id || crypto.randomUUID(),
        session.userId,
        session.refreshHash,
        session.createdAt || new Date(),
        session.expiresAt,
        session.revokedAt ?? null,
        session.userAgent ?? null,
        session.replacedBy ?? null,
      ]
    );
    return session;
  }

  findActiveSession(sid, userId) {
    return this.pool.query(
      `SELECT * FROM auth_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
      [sid, userId]
    ).then((result) => result.rows[0] || null);
  }

  async rotateSession(oldHash, replacement) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await client.query(
        `SELECT * FROM auth_sessions WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > NOW() FOR UPDATE`,
        [oldHash]
      );
      if (!previous.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `UPDATE auth_sessions SET revoked_at = NOW(), replaced_by = $1 WHERE refresh_hash = $2`,
        [replacement._id, oldHash]
      );
      await client.query(
        `INSERT INTO auth_sessions (id, user_id, refresh_hash, created_at, expires_at, revoked_at, user_agent, replaced_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          replacement._id,
          replacement.userId,
          replacement.refreshHash,
          replacement.createdAt || new Date(),
          replacement.expiresAt,
          replacement.revokedAt ?? null,
          replacement.userAgent ?? null,
          replacement.replacedBy ?? null,
        ]
      );
      await client.query('COMMIT');
      return previous.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  findOneByRefreshHash(refreshHash) {
    return this.pool.query(
      `SELECT * FROM auth_sessions WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [refreshHash]
    ).then((result) => result.rows[0] || null);
  }

  async revokeSession(sid, userId) {
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sid, userId]
    );
  }

  async revokeByRefreshHash(hash) {
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = NOW() WHERE refresh_hash = $1 AND revoked_at IS NULL`,
      [hash]
    );
  }

  async revokeAllSessions(userId) {
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
  }

  // ---------------------------------------------------------------------------
  // Friends
  // ---------------------------------------------------------------------------

  pairKey(a, b) {
    return pairKey(a, b);
  }

  async areFriends(a, b) {
    const result = await this.pool.query(
      `SELECT 1 FROM friendships WHERE pair_key = $1 LIMIT 1`,
      [pairKey(a, b)]
    );
    return result.rows.length > 0;
  }

  async requestFriend(senderId, recipientId) {
    const key = pairKey(senderId, recipientId);

    // Already friends?
    if (await this.areFriends(senderId, recipientId)) {
      return { state: 'already-friends' };
    }

    // Existing pending request?
    const existing = await this.pool.query(
      `SELECT * FROM friend_requests WHERE pair_key = $1 AND state = 'pending'`,
      [key]
    );
    if (existing.rows.length > 0) {
      const req = existing.rows[0];
      if (req.sender_id === senderId) {
        return { state: 'pending', request: this._rowToFriendRequest(req) };
      }
      // Reverse direction pending - accept it
      const accepted = await this.acceptPendingRequest(req.id, recipientId, senderId);
      if (accepted) return { state: 'accepted', request: accepted };
      return this.requestFriend(senderId, recipientId);
    }

    // Verify recipient exists
    const target = await this.pool.query(
      `SELECT id FROM users WHERE id = $1`,
      [recipientId]
    );
    if (!target.rows[0]) return { state: 'not-found' };

    const requestId = crypto.randomUUID();
    try {
      await this.pool.query(
        `INSERT INTO friend_requests (id, pair_key, sender_id, recipient_id, state, created_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [requestId, key, senderId, recipientId]
      );
      return {
        state: 'pending',
        request: this._rowToFriendRequest({
          id: requestId,
          pair_key: key,
          sender_id: senderId,
          recipient_id: recipientId,
          state: 'pending',
          created_at: new Date(),
          responded_at: null,
        }),
      };
    } catch (error) {
      if (error.code !== '23505') throw error; // unique_violation
      const concurrent = await this.pool.query(
        `SELECT * FROM friend_requests WHERE pair_key = $1 AND state = 'pending'`,
        [key]
      );
      if (concurrent.rows.length > 0) {
        const req = concurrent.rows[0];
        if (req.sender_id === senderId) {
          return { state: 'pending', request: this._rowToFriendRequest(req) };
        }
        if (req.sender_id === recipientId && req.recipient_id === senderId) {
          const accepted = await this.acceptPendingRequest(req.id, senderId, recipientId);
          if (accepted) return { state: 'accepted', request: accepted };
        }
      }
      return { state: 'conflict' };
    }
  }

  async acceptPendingRequest(requestId, recipientId, senderId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const accepted = await client.query(
        `UPDATE friend_requests SET state = 'accepted', responded_at = NOW()
         WHERE id = $1 AND recipient_id = $2 AND sender_id = $3 AND state = 'pending'
         RETURNING *`,
        [requestId, recipientId, senderId]
      );
      if (!accepted.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const req = accepted.rows[0];
      const key = req.pair_key;
      const ids = [req.sender_id, req.recipient_id].sort();
      await client.query(
        `INSERT INTO friendships (pair_key, user_ids, created_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (pair_key) DO NOTHING`,
        [key, ids, req.responded_at || new Date()]
      );
      await client.query('COMMIT');
      return this._rowToFriendRequest(req);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async respondFriendRequest(requestId, recipientId, accept) {
    if (accept) {
      const pending = await this.pool.query(
        `SELECT * FROM friend_requests WHERE id = $1 AND recipient_id = $2 AND state = 'pending'`,
        [requestId, recipientId]
      );
      if (!pending.rows[0]) return null;
      return this.acceptPendingRequest(requestId, recipientId, pending.rows[0].sender_id);
    }
    const result = await this.pool.query(
      `UPDATE friend_requests SET state = 'declined', responded_at = NOW()
       WHERE id = $1 AND recipient_id = $2 AND state = 'pending'
       RETURNING *`,
      [requestId, recipientId]
    );
    return result.rows[0] ? this._rowToFriendRequest(result.rows[0]) : null;
  }

  async cancelFriendRequest(requestId, senderId) {
    const result = await this.pool.query(
      `DELETE FROM friend_requests WHERE id = $1 AND sender_id = $2 AND state = 'pending' RETURNING *`,
      [requestId, senderId]
    );
    return result.rows[0] ? this._rowToFriendRequest(result.rows[0]) : null;
  }

  async removeFriend(a, b) {
    const key = pairKey(a, b);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM friendships WHERE pair_key = $1`, [key]);
      await client.query(
        `UPDATE friend_requests SET state = 'removed', responded_at = NOW() WHERE pair_key = $1`,
        [key]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listFriends(userId) {
    const docs = await this.pool.query(
      `SELECT user_ids FROM friendships WHERE user_ids @> ARRAY[$1::UUID] ORDER BY created_at DESC`,
      [userId]
    );
    const friendIds = docs.rows
      .map((doc) => doc.user_ids.find((id) => id !== userId))
      .filter(Boolean);
    if (friendIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT id, username, display_name, avatar_url, email_verified FROM users WHERE id = ANY($1::UUID[])`,
      [friendIds]
    );
    return result.rows.map((r) => this._rowToUser(r));
  }

  async listRequests(userId) {
    const result = await this.pool.query(
      `SELECT * FROM friend_requests
       WHERE state = 'pending' AND (recipient_id = $1 OR sender_id = $1)
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map((r) => this._rowToFriendRequest(r));
  }

  async findUsersByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT id, username, display_name, avatar_url, email_verified FROM users WHERE id = ANY($1::UUID[])`,
      [ids]
    );
    return result.rows.map((r) => this._rowToUser(r));
  }

  _rowToFriendRequest(row) {
    if (!row) return null;
    return {
      _id: row.id,
      id: row.id,
      pairKey: row.pair_key,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      state: row.state,
      createdAt: row.created_at,
      respondedAt: row.responded_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Private conversations
  // ---------------------------------------------------------------------------

  async createPrivateConversation(userIds, pairKeyValue) {
    const result = await this.pool.query(
      `INSERT INTO private_conversations (id, pair_key, user_ids, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING *`,
      [crypto.randomUUID(), pairKeyValue, userIds.sort()]
    );
    return result.rows[0];
  }

  async getPrivateConversation(pairKeyValue) {
    const result = await this.pool.query(
      `SELECT * FROM private_conversations WHERE pair_key = $1`,
      [pairKeyValue]
    );
    return result.rows[0] || null;
  }

  async getPrivateConversationById(conversationId) {
    const result = await this.pool.query(
      `SELECT * FROM private_conversations WHERE id = $1`,
      [conversationId]
    );
    return result.rows[0] || null;
  }

  async getPrivateConversationsForUser(userId) {
    const result = await this.pool.query(
      `SELECT * FROM private_conversations WHERE user_ids @> ARRAY[$1::UUID] ORDER BY updated_at DESC`,
      [userId]
    );
    return result.rows;
  }

  // ---------------------------------------------------------------------------
  // Private messages
  // ---------------------------------------------------------------------------

  async savePrivateMessage(conversationId, message) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO private_messages (id, conversation_id, from_id, sender_name, text, timestamp, delivered_to, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          message.id,
          conversationId,
          message.from,
          message.sender,
          message.text,
          new Date(message.timestamp),
          [],
        ]
      );
      await client.query(
        `UPDATE private_conversations SET updated_at = NOW() WHERE id = $1`,
        [conversationId]
      );
      await client.query('COMMIT');
      return {
        _id: message.id,
        id: message.id,
        conversationId,
        from: message.from,
        sender: message.sender,
        text: message.text,
        timestamp: new Date(message.timestamp),
        deliveredTo: [],
        createdAt: new Date(),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPrivateMessages(conversationId, limit = 50) {
    const result = await this.pool.query(
      `SELECT * FROM private_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit]
    );
    return result.rows.reverse().map((r) => this._rowToPrivateMessage(r));
  }

  async markMessageDelivered(messageId, userId) {
    await this.pool.query(
      `UPDATE private_messages SET delivered_to = array_append(delivered_to, $1::UUID) WHERE id = $2 AND NOT ($1::UUID = ANY(delivered_to))`,
      [userId, messageId]
    );
  }

  async getUndeliveredMessagesForUser(userId) {
    const result = await this.pool.query(
      `SELECT * FROM private_messages WHERE NOT ($1::UUID = ANY(delivered_to)) ORDER BY created_at ASC`,
      [userId]
    );
    return result.rows.map((r) => this._rowToPrivateMessage(r));
  }

  async markConversationMessagesDelivered(conversationId, userId) {
    await this.pool.query(
      `UPDATE private_messages SET delivered_to = array_append(delivered_to, $1::UUID)
       WHERE conversation_id = $2 AND NOT ($1::UUID = ANY(delivered_to))`,
      [userId, conversationId]
    );
  }

  async findPrivateMessageById(messageId) {
    const result = await this.pool.query(
      `SELECT * FROM private_messages WHERE id = $1`,
      [messageId]
    );
    return result.rows[0] || null;
  }

  _rowToPrivateMessage(row) {
    if (!row) return null;
    return {
      _id: row.id,
      id: row.id,
      conversationId: row.conversation_id,
      from: row.from_id,
      sender: row.sender_name,
      text: row.text,
      timestamp: row.timestamp,
      deliveredTo: row.delivered_to || [],
      createdAt: row.created_at,
    };
  }
}

module.exports = { PgStore, pairKey, buildSslConfig, isValidPemCertificate };