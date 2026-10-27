'use strict';

/**
 * TempChat PostgreSQL Store Tests
 *
 * These tests require a live PostgreSQL database (Supabase or local).
 * Set DATABASE_URL environment variable before running.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node backend/test/pg-store.js
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PgStore } = require('../pg-store');

let store = null;
const testUsers = [];

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('SKIP: DATABASE_URL not set. PostgreSQL store tests require a live database.');
    console.log('  Example: DATABASE_URL="postgresql://postgres:password@localhost:5432/postgres" node backend/test/pg-store.js');
    return;
  }

  console.log('Connecting to PostgreSQL...');
  store = await PgStore.connect({ databaseUrl, pgSsl: 'false', jwtSecret: 'test-secret-that-is-long-enough-for-testing-12345' });

  const userId1 = crypto.randomUUID();
  const userId2 = crypto.randomUUID();
  testUsers.push(userId1, userId2);

  // --- Test 1: Create user ---
  console.log('Test 1: Create user...');
  const user1 = await store.createUser({
    _id: userId1,
    username: 'alice_migrator',
    usernameKey: 'alice_migrator',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test$test',
    googleSub: null,
    displayName: 'Alice',
    avatarUrl: null,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.equal(user1.username, 'alice_migrator');
  assert.equal(user1.displayName, 'Alice');

  const user2 = await store.createUser({
    _id: userId2,
    username: 'bob_migrator',
    usernameKey: 'bob_migrator',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test$test',
    googleSub: null,
    displayName: 'Bob',
    avatarUrl: null,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.equal(user2.username, 'bob_migrator');

  // --- Test 2: Find user by ID ---
  console.log('Test 2: Find user by ID...');
  const found = await store.findUserById(userId1);
  assert.ok(found);
  assert.equal(found.username, 'alice_migrator');

  // --- Test 3: Find user by username ---
  console.log('Test 3: Find user by username...');
  const foundByName = await store.findUserByUsername('alice_migrator');
  assert.ok(foundByName);
  assert.equal(foundByName.id, userId1);

  // --- Test 4: Duplicate username ---
  console.log('Test 4: Duplicate username rejection...');
  await assert.rejects(
    store.createUser({
      _id: crypto.randomUUID(),
      username: 'alice_migrator',
      usernameKey: 'alice_migrator',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test$test',
      googleSub: null,
      displayName: 'Duplicate',
      avatarUrl: null,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    (err) => err.code === '23505' // PostgreSQL unique_violation
  );

  // --- Test 5: Update user ---
  console.log('Test 5: Update user...');
  const updated = await store.updateUser(userId1, { displayName: 'Alice Updated', updatedAt: new Date() });
  assert.equal(updated.displayName, 'Alice Updated');

  // --- Test 6: Create session ---
  console.log('Test 6: Create and find active session...');
  const sessionId = crypto.randomUUID();
  await store.createSession({
    _id: sessionId,
    userId: userId1,
    refreshHash: 'test-refresh-hash',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 10000000),
    revokedAt: null,
    userAgent: 'test-agent',
  });
  const active = await store.findActiveSession(sessionId, userId1);
  assert.ok(active);
  assert.equal(active.refreshHash, 'test-refresh-hash');

  // --- Test 7: Rotate session ---
  console.log('Test 7: Rotate session...');
  const replacementId = crypto.randomUUID();
  const rotated = await store.rotateSession('test-refresh-hash', {
    _id: replacementId,
    userId: userId1,
    refreshHash: 'new-refresh-hash',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 10000000),
    revokedAt: null,
    userAgent: 'test-agent',
  });
  assert.ok(rotated);
  assert.equal(rotated.refreshHash, 'test-refresh-hash');

  const stillActive = await store.findActiveSession(sessionId, userId1);
  assert.equal(stillActive, null); // old session revoked

  const newActive = await store.findActiveSession(replacementId, userId1);
  assert.ok(newActive);
  assert.equal(newActive.refreshHash, 'new-refresh-hash');

  // --- Test 8: Find by refresh hash ---
  console.log('Test 8: Find by refresh hash...');
  const byHash = await store.findOneByRefreshHash('new-refresh-hash');
  assert.ok(byHash);
  assert.equal(byHash.id, replacementId);

  // --- Test 9: Friend request ---
  console.log('Test 9: Friend request flow...');
  const result = await store.requestFriend(userId1, userId2);
  assert.equal(result.state, 'pending');
  assert.ok(result.request);
  assert.equal(result.request.senderId, userId1);
  assert.equal(result.request.recipientId, userId2);

  // Duplicate request
  const dup = await store.requestFriend(userId1, userId2);
  assert.equal(dup.state, 'pending');

  // Self request
  const selfReq = await store.requestFriend(userId1, userId1);
  assert.equal(selfReq.state, 'already-friends' || selfReq.state === 'already-friends' ? 'already-friends' : selfReq.state);

  // --- Test 10: List requests ---
  console.log('Test 10: List friend requests...');
  const requests = await store.listRequests(userId1);
  assert.ok(requests.length > 0);
  const incoming = await store.listRequests(userId2);
  assert.ok(incoming.length > 0);

  // --- Test 11: Accept friend request ---
  console.log('Test 11: Accept friend request...');
  const accepted = await store.respondFriendRequest(result.request._id, userId2, true);
  assert.ok(accepted);
  assert.equal(accepted.state, 'accepted');

  // Verify friendship exists
  const friends = await store.areFriends(userId1, userId2);
  assert.equal(friends, true);

  // --- Test 12: List friends ---
  console.log('Test 12: List friends...');
  const user1Friends = await store.listFriends(userId1);
  assert.equal(user1Friends.length, 1);
  assert.equal(user1Friends[0].id, userId2);

  // --- Test 13: Remove friend ---
  console.log('Test 13: Remove friend...');
  await store.removeFriend(userId1, userId2);
  const notFriends = await store.areFriends(userId1, userId2);
  assert.equal(notFriends, false);

  // --- Test 14: Private conversation ---
  console.log('Test 14: Private conversation...');
  const pairKey = store.pairKey(userId1, userId2);
  const conv = await store.createPrivateConversation([userId1, userId2], pairKey);
  assert.ok(conv);
  assert.equal(conv.pair_key, pairKey);

  const foundConv = await store.getPrivateConversation(pairKey);
  assert.ok(foundConv);
  assert.equal(foundConv.id, conv.id);

  const foundById = await store.getPrivateConversationById(conv.id);
  assert.ok(foundById);

  const userConvs = await store.getPrivateConversationsForUser(userId1);
  assert.ok(userConvs.length > 0);

  // --- Test 15: Save and get private message ---
  console.log('Test 15: Save and get private message...');
  const messageId = crypto.randomUUID();
  const saved = await store.savePrivateMessage(conv.id, {
    id: messageId,
    from: userId1,
    sender: 'Alice',
    text: 'Hello Bob!',
    timestamp: Date.now(),
  });
  assert.ok(saved);
  assert.equal(saved.text, 'Hello Bob!');

  const messages = await store.getPrivateMessages(conv.id, 50);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'Hello Bob!');
  assert.equal(messages[0].from, userId1);

  // --- Test 16: Mark delivered ---
  console.log('Test 16: Mark message delivered...');
  await store.markMessageDelivered(messageId, userId2);
  const deliveredMsg = await store.findPrivateMessageById(messageId);
  assert.ok(deliveredMsg.deliveredTo.includes(userId2));

  // --- Test 17: Undelivered messages ---
  console.log('Test 17: Undelivered messages...');
  const undelivered = await store.getUndeliveredMessagesForUser(userId1);
  assert.ok(Array.isArray(undelivered));

  await store.markConversationMessagesDelivered(conv.id, userId1);
  const stillUndelivered = await store.getUndeliveredMessagesForUser(userId1);
  // Message was delivered to both now
  assert.ok(stillUndelivered.length === 0 || stillUndelivered.every((m) => m.deliveredTo.includes(userId1)));

  // --- Test 18: Search users ---
  console.log('Test 18: Search users...');
  const searchResults = await store.searchUsers('alice', 20);
  assert.ok(searchResults.some((u) => u.id === userId1));

  // --- Test 19: Find users by IDs ---
  console.log('Test 19: Find users by IDs...');
  const foundUsers = await store.findUsersByIds([userId1, userId2]);
  assert.equal(foundUsers.length, 2);

  // --- Test 20: Revoke session ---
  console.log('Test 20: Revoke session...');
  await store.revokeByRefreshHash('new-refresh-hash');
  const revoked = await store.findOneByRefreshHash('new-refresh-hash');
  assert.equal(revoked, null);

  console.log('\nAll PostgreSQL store tests passed!');

  await store.close();
}

run().catch((error) => {
  console.error('PostgreSQL store test failed:', error.message);
  process.exitCode = 1;
});