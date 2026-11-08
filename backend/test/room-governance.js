'use strict';

// Exercises the additive room governance layer: host/admin roles, locking,
// member limits, settings authorization and kick semantics. The room lives
// only in the server process, so this test drives a real Socket.IO server in
// test mode exactly like the existing socket smoke test.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const port = 3014;
const url = 'http://127.0.0.1:' + port;
const clients = [];
let server;

function waitFor(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + event)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function emitAck(socket, event, data) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + event + ' acknowledgement')), 5000);
    socket.emit(event, data, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function connect() {
  const socket = io(url, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  return socket;
}

async function waitForUser(socket, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let latest = [];
  while (Date.now() < deadline) {
    latest = await waitFor(socket, 'update-users', Math.max(250, deadline - Date.now()));
    if (predicate(latest)) return latest;
  }
  throw new Error('Timed out waiting for the expected member list');
}

async function joinAndApprove(host, guest, username, roomCode) {
  const received = waitFor(host, 'join-request-received');
  const request = await emitAck(guest, 'join-request', { username, roomCode });
  assert.equal(request.success, true, username + ' should be allowed to request access');
  const invite = await received;
  const approved = waitFor(guest, 'join-request-approved');
  host.emit('join-request-approve', { requestId: invite.requestId });
  const result = await approved;
  assert.equal(result.roomCode, roomCode);
  return result;
}

async function run() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname.replace(/[\\/]test$/, ''),
    env: { ...process.env, PORT: String(port), TEMPCHAT_TEST_MODE: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const serverReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 5000);
    server.stdout.on('data', (data) => {
      if (data.toString().includes('Socket.IO server ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.once('error', reject);
  });
  await serverReady;

  const host = connect();
  const guest = connect();
  const third = connect();
  const fourth = connect();
  const fifth = connect();
  await Promise.all([host, guest, third, fourth, fifth].map((socket) => waitFor(socket, 'connect')));

  const created = await emitAck(host, 'create-room', {
    username: 'Host',
    settings: { maxMembers: 3, expiresInMinutes: 60, messageTtlMinutes: 15 }
  });
  assert.equal(created.success, true);
  assert.equal(created.isHost, true);
  assert.equal(created.role, 'host');
  assert.equal(created.settings.maxMembers, 3);
  assert.equal(created.settings.locked, false);
  assert.equal(created.settings.messageTtlMinutes, 15);
  assert.ok(created.settings.expiresAt > Date.now(), 'the room should have an expiry timestamp');
  const roomCode = created.roomCode;

  const joinedNotice = waitFor(host, 'system-message');
  await joinAndApprove(host, guest, 'Guest', roomCode);
  assert.match(await joinedNotice, /Guest joined the room/);

  // Host can promote a member; the member sees their new role in the list.
  const promotedNotice = waitFor(host, 'system-message');
  const afterPromote = waitForUser(host, (users) => users.some((user) => user.id === guest.id && user.role === 'admin'));
  const promote = await emitAck(host, 'room:promote', { socketId: guest.id });
  assert.equal(promote.success, true);
  assert.match(await promotedNotice, /Guest is now an admin/);
  assert.ok((await afterPromote).some((user) => user.id === guest.id && user.role === 'admin'));

  // Admins cannot change room settings; only the host can.
  const deniedSettings = await emitAck(guest, 'room:update-settings', { maxMembers: 10 });
  assert.equal(deniedSettings.success, false);

  await joinAndApprove(host, third, 'Third', roomCode);

  // An admin can remove a regular member but never the host.
  const kicked = waitFor(third, 'room:kicked');
  const afterKick = waitForUser(host, (users) => !users.some((user) => user.id === third.id));
  const kick = await emitAck(guest, 'room:kick', { socketId: third.id });
  assert.equal(kick.success, true);
  assert.match((await kicked).message, /removed from the room/i);
  await afterKick;

  const kickHost = await emitAck(guest, 'room:kick', { socketId: host.id });
  assert.equal(kickHost.success, false, 'an admin must not be able to remove the host');

  // Locking stops new join requests until the host unlocks the room.
  const locked = waitFor(guest, 'room:settings');
  const lock = await emitAck(host, 'room:lock', { locked: true });
  assert.equal(lock.success, true);
  assert.equal((await locked).locked, true);

  const lockedRequest = await emitAck(fourth, 'join-request', { username: 'Fourth', roomCode });
  assert.equal(lockedRequest.success, false);
  assert.match(lockedRequest.message, /locked/i);

  const unlocked = waitFor(guest, 'room:settings');
  const unlock = await emitAck(host, 'room:lock', { locked: false });
  assert.equal(unlock.success, true);
  assert.equal((await unlocked).locked, false);

  await joinAndApprove(host, fourth, 'Fourth', roomCode);

  // Room is at its 3-person limit now.
  const fullRequest = await emitAck(fifth, 'join-request', { username: 'Fifth', roomCode });
  assert.equal(fullRequest.success, false);
  assert.match(fullRequest.message, /full/i);

  // Lowering the limit below the current occupancy is rejected; raising it works.
  const tooSmall = await emitAck(host, 'room:update-settings', { maxMembers: 2 });
  assert.equal(tooSmall.success, false);
  const raised = await emitAck(host, 'room:update-settings', { maxMembers: 5, messageTtlMinutes: 0 });
  assert.equal(raised.success, true);
  assert.equal(raised.settings.maxMembers, 5);
  assert.equal(raised.settings.messageTtlMinutes, 0);

  // Demoting an admin removes their moderation rights.
  const demoted = waitFor(guest, 'system-message');
  const demote = await emitAck(host, 'room:demote', { socketId: guest.id });
  assert.equal(demote.success, true);
  assert.match(await demoted, /no longer an admin/);
  const kickAfterDemote = await emitAck(guest, 'room:kick', { socketId: fourth.id });
  assert.equal(kickAfterDemote.success, false, 'a demoted member must lose moderation rights');

  // Non-hosts cannot lock the room either.
  const guestLock = await emitAck(guest, 'room:lock', { locked: true });
  assert.equal(guestLock.success, false);

  console.log('Room governance tests passed: host/admin roles, settings authorization, join/leave notices, member limits, room locking, kick restrictions, promotion and demotion.');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const client of clients) client.disconnect();
    if (server) server.kill();
  });
