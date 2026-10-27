'use strict';

/**
 * TempChat MongoDB to PostgreSQL Migration Script
 *
 * Reads existing MongoDB Atlas data and copies it to Supabase PostgreSQL.
 * Supports dry-run mode, safe retries, and produces a migration report.
 *
 * Usage:
 *   node scripts/migrate-mongo-to-pg.js           # Full migration
 *   node scripts/migrate-mongo-to-pg.js --dry-run # Dry run (no writes)
 *
 * Required environment variables:
 *   MONGODB_URI         - Source MongoDB Atlas connection string
 *   MONGODB_DB_NAME     - Source database name (default: tempchat)
 *   DATABASE_URL        - Target Supabase PostgreSQL connection string
 *   JWT_SECRET          - Required for config validation
 *   TEMPCHAT_PG_DEBUG   - Set to 'true' for verbose PostgreSQL logging
 */

const { MongoClient } = require('mongodb');
const { PgStore } = require('../pg-store');
const { readConfig } = require('../config');

const SOURCE_DB_NAME = process.env.MONGODB_DB_NAME || 'tempchat';
const DRY_RUN = process.argv.includes('--dry-run');

const report = {
  startedAt: new Date().toISOString(),
  dryRun: DRY_RUN,
  collections: {},
  errors: [],
  summary: {},
};

function log(message, level = 'info') {
  const prefix = DRY_RUN ? '[DRY-RUN] ' : '';
  console.log(`[${new Date().toISOString()}] ${prefix}${message}`);
}

function error(message, err) {
  report.errors.push({ message, error: err?.message || String(err) });
  console.error(`[ERROR] ${message}`, err?.message || '');
}

async function main() {
  let mongoClient;
  let pgStore;

  try {
    // --- Validate configuration ---
    const config = readConfig({ allowTestMode: true });
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required for migration');
    }
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is required for migration (source database)');
    }

    log(`Migration started. Dry run: ${DRY_RUN}`);
    log(`Source: MongoDB Atlas database "${SOURCE_DB_NAME}"`);
    log(`Target: Supabase PostgreSQL`);

    // --- Connect to MongoDB (source) ---
    mongoClient = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
    });
    await mongoClient.connect();
    await mongoClient.db().command({ ping: 1 });
    const mongoDb = mongoClient.db(SOURCE_DB_NAME);
    log('Connected to MongoDB source.');

    // --- Connect to PostgreSQL (target) ---
    pgStore = await PgStore.connect(config);
    log('Connected to PostgreSQL target. Schema ensured.');

    // --- Migrate users ---
    await migrateCollection('users', mongoDb.collection('users'), async (doc) => {
      return {
        _id: String(doc._id),
        username: doc.username,
        usernameKey: doc.usernameKey || doc.username.toLowerCase(),
        passwordHash: doc.passwordHash,
        googleSub: doc.googleSub ?? null,
        displayName: doc.displayName || doc.username,
        avatarUrl: doc.avatarUrl ?? null,
        emailVerified: doc.emailVerified !== false,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      };
    }, (u) => pgStore.createUser(u));

    // --- Migrate auth_sessions ---
    await migrateCollection('auth_sessions', mongoDb.collection('auth_sessions'), async (doc) => {
      return {
        _id: String(doc._id),
        userId: String(doc.userId),
        refreshHash: doc.refreshHash,
        createdAt: doc.createdAt || new Date(),
        expiresAt: doc.expiresAt || new Date(),
        revokedAt: doc.revokedAt ?? null,
        userAgent: doc.userAgent ?? null,
        replacedBy: doc.replacedBy ?? null,
      };
    }, (s) => pgStore.createSession(s));

    // --- Migrate friend_requests ---
    await migrateCollection('friend_requests', mongoDb.collection('friend_requests'), async (doc) => {
      return {
        _id: String(doc._id),
        pairKey: doc.pairKey,
        senderId: String(doc.senderId),
        recipientId: String(doc.recipientId),
        state: doc.state || 'pending',
        createdAt: doc.createdAt || new Date(),
        respondedAt: doc.respondedAt ?? null,
      };
    }, (r) => {
      // Use raw SQL for friend requests since they may have arbitrary pair_key
      return pgStore.pool.query(
        `INSERT INTO friend_requests (id, pair_key, sender_id, recipient_id, state, created_at, responded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [r._id, r.pairKey, r.senderId, r.recipientId, r.state, r.createdAt, r.respondedAt]
      );
    });

    // --- Migrate friendships ---
    await migrateCollection('friendships', mongoDb.collection('friendships'), async (doc) => {
      return {
        pairKey: doc.pairKey,
        userIds: doc.userIds || [],
        createdAt: doc.createdAt || new Date(),
      };
    }, (f) => pgStore.pool.query(
      `INSERT INTO friendships (pair_key, user_ids, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (pair_key) DO NOTHING`,
      [f.pairKey, f.userIds, f.createdAt]
    ));

    // --- Migrate private_conversations ---
    await migrateCollection('private_conversations', mongoDb.collection('private_conversations'), async (doc) => {
      return {
        _id: String(doc._id),
        pairKey: doc.pairKey,
        userIds: doc.userIds || [],
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      };
    }, (c) => pgStore.pool.query(
      `INSERT INTO private_conversations (id, pair_key, user_ids, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [c._id, c.pairKey, c.userIds, c.createdAt, c.updatedAt]
    ));

    // --- Migrate private_messages ---
    await migrateCollection('private_messages', mongoDb.collection('private_messages'), async (doc) => {
      return {
        _id: String(doc._id),
        conversationId: String(doc.conversationId),
        from: String(doc.from),
        sender: doc.sender || '',
        text: doc.text || '',
        timestamp: doc.timestamp || new Date(),
        deliveredTo: doc.deliveredTo || [],
      };
    }, (m) => pgStore.pool.query(
      `INSERT INTO private_messages (id, conversation_id, from_id, sender_name, text, timestamp, delivered_to, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [m._id, m.conversationId, m.from, m.sender, m.text, m.timestamp, m.deliveredTo]
    ));

    // --- Summary ---
    report.finishedAt = new Date().toISOString();
    report.summary = {
      totalCollections: Object.keys(report.collections).length,
      totalRead: Object.values(report.collections).reduce((sum, c) => sum + c.read, 0),
      totalWritten: Object.values(report.collections).reduce((sum, c) => sum + c.written, 0),
      totalErrors: report.errors.length,
    };

    log('Migration complete.');
    log(`Read: ${report.summary.totalRead}, Written: ${report.summary.totalWritten}, Errors: ${report.summary.totalErrors}`);
    console.log(JSON.stringify(report, null, 2));

  } catch (err) {
    error('Migration failed', err);
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    if (mongoClient) await mongoClient.close().catch(() => {});
    if (pgStore) await pgStore.close().catch(() => {});
  }
}

async function migrateCollection(name, collection, transform, writeFn) {
  const colReport = { read: 0, written: 0, errors: 0 };
  report.collections[name] = colReport;

  try {
    const cursor = collection.find({});
    let batch = [];

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      colReport.read++;

      if (DRY_RUN) {
        // Just validate the transform in dry-run mode
        try {
          await transform(doc);
        } catch (err) {
          colReport.errors++;
          error(`Failed to transform ${name} document ${doc._id}`, err);
        }
        continue;
      }

      batch.push({ doc, transform: () => transform(doc) });

      // Process in batches of 50
      if (batch.length >= 50) {
        await processBatch(batch, writeFn, colReport);
        batch = [];
      }
    }

    if (batch.length > 0) {
      await processBatch(batch, writeFn, colReport);
    }

    log(`${name}: read ${colReport.read}, written ${colReport.written}, errors ${colReport.errors}`);
  } catch (err) {
    error(`Failed to migrate collection "${name}"`, err);
    colReport.errors++;
  }
}

async function processBatch(batch, writeFn, colReport) {
  for (const item of batch) {
    try {
      const transformed = await item.transform();
      if (!DRY_RUN) {
        await writeFn(transformed);
      }
      colReport.written++;
    } catch (err) {
      colReport.errors++;
      error(`Failed to write document`, err);
    }
  }
}

main();