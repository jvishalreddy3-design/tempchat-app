const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const port = 3012;
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

  const healthResponse = await fetch(url + '/health');
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true });
  assert.equal(healthResponse.headers.get('x-powered-by'), null);

  const host = connect();
  const guest = connect();
  const outsider = connect();
  await Promise.all([waitFor(host, 'connect'), waitFor(guest, 'connect'), waitFor(outsider, 'connect')]);

  const rejectedOrigin = io(url, {
    transports: ['polling'],
    forceNew: true,
    extraHeaders: { Origin: 'https://untrusted.invalid' }
  });
  clients.push(rejectedOrigin);
  await waitFor(rejectedOrigin, 'connect_error');
  assert.equal(rejectedOrigin.connected, false);

  const created = await emitAck(host, 'create-room', { username: 'Host' });
  assert.equal(created.success, true);
  assert.match(created.roomCode, /^\d{6}$/);

  const joinRequest = waitFor(host, 'join-request-received');
  const join = await emitAck(guest, 'join-request', { username: 'Guest', roomCode: created.roomCode });
  assert.deepEqual({ success: join.success, pending: join.pending }, { success: true, pending: true });
  const requested = await joinRequest;
  assert.equal(requested.username, 'Guest');

  const approved = waitFor(guest, 'join-request-approved');
  const users = waitFor(host, 'update-users');
  host.emit('join-request-approve', { requestId: requested.requestId });
  assert.equal((await approved).roomCode, created.roomCode);
  assert.ok((await users).some((user) => user.username === 'Guest'));

  const receivedByGuest = waitFor(guest, 'chat-message');
  let receivedByOutsider = false;
  outsider.once('chat-message', () => { receivedByOutsider = true; });
  host.emit('chat-message', {
    v: 1,
    id: 'smoke-message-123456',
    from: host.id,
    to: guest.id,
    ct: 'Y2lwaGVydGV4dA==',
    iv: 'bm9uY2U=',
    salt: 'c2FsdA=='
  });
  const message = await receivedByGuest;
  assert.equal(message.to, guest.id);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(receivedByOutsider, false);

  const fileReceivedByGuest = waitFor(guest, 'chat-message');
  const encryptedChunk = Buffer.alloc(1024 * 1024 + 16).toString('base64');
  host.emit('chat-message', {
    v: 1,
    id: 'file-message-123456',
    from: host.id,
    to: guest.id,
    type: 'file',
    file: {
      v: 1,
      fid: 'file-id-12345678',
      name: 'sample.bin',
      type: 'application/octet-stream',
      size: 1024 * 1024,
      salt: 'c2FsdA==',
      chunks: [{ idx: 0, ct: encryptedChunk, iv: 'bm9uY2U=' }]
    }
  });
  const fileMessage = await fileReceivedByGuest;
  assert.equal(fileMessage.file.chunks[0].idx, 0);

  let invalidFileReceived = false;
  guest.once('chat-message', () => { invalidFileReceived = true; });
  host.emit('chat-message', {
    v: 1,
    id: 'invalid-file-123456',
    from: host.id,
    to: guest.id,
    type: 'file',
    file: {
      v: 1,
      fid: 'file-id-12345678',
      name: 'sample.bin',
      type: 'application/octet-stream',
      size: 1,
      salt: 'c2FsdA==',
      chunks: [{ idx: 1, ct: 'YQ==', iv: 'bm9uY2U=' }]
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(invalidFileReceived, false);

  let forgedMessageReceived = false;
  guest.once('chat-message', () => { forgedMessageReceived = true; });
  host.emit('chat-message', {
    v: 1,
    id: 'forged-message-123456',
    from: guest.id,
    to: guest.id,
    ct: 'Y2lwaGVydGV4dA==',
    iv: 'bm9uY2U=',
    salt: 'c2FsdA=='
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(forgedMessageReceived, false);

  console.log('Socket smoke test passed: room creation, approval, presence, isolation, encrypted routing and file chunk validation.');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const client of clients) client.disconnect();
    server?.kill();
  });
