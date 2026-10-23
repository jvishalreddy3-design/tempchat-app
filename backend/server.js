const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_CHUNK_BYTES = 1024 * 1024;
const MAX_SOCKET_PAYLOAD_BYTES = 75 * 1024 * 1024;
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || [
    'https://tempchat-app-backend.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://localhost',
    'capacitor://localhost'
  ].join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const io = new Server(server, {
  maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
  cors: {
    origin(origin, callback) {
      // Native Capacitor WebViews and non-browser Socket.IO clients may omit
      // Origin. Browser callers must be explicitly allowed.
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: false
  }
});

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('/health', (_request, response) => response.json({ ok: true }));

const rooms = new Map();
const rateLimits = new Map();

function generateRoomCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function checkRateLimit(socket) {
  const now = Date.now();
  if (!rateLimits.has(socket.id)) {
    rateLimits.set(socket.id, { count: 1, startTime: now });
    return true;
  }
  const limit = rateLimits.get(socket.id);
  if (now - limit.startTime > 10000) {
    limit.count = 1;
    limit.startTime = now;
    return true;
  }
  limit.count++;
  if (limit.count > 30) {
    return false;
  }
  return true;
}

function cleanRateLimit(socketId) {
  rateLimits.delete(socketId);
}

// ---------------------------------------------------------------------------
// Host approval helpers
// ---------------------------------------------------------------------------
const MAX_PENDING_PER_ROOM = 20;
const ROOM_EMPTY_GRACE_MS = 60 * 1000;   // keep an empty room briefly so a host refresh can rejoin
const HOST_HANDOFF_GRACE_MS = 45 * 1000; // wait for the host to come back before promoting someone

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 30);
}

function isValidRoomCode(value) {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

function isValidId(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 160;
}

function isBase64(value, maxLength = 65536) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function isValidFilePayload(file) {
  if (!file || typeof file !== 'object') return false;
  if (typeof file.fid !== 'string' || file.fid.length > 128) return false;
  if (typeof file.name !== 'string' || file.name.length > 255) return false;
  if (typeof file.type !== 'string' || file.type.length > 128) return false;
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES) return false;
  if (!isBase64(file.salt, 256) || !Array.isArray(file.chunks) || file.chunks.length < 1 || file.chunks.length > 1024) return false;

  let decryptedSize = 0;
  for (let index = 0; index < file.chunks.length; index++) {
    const chunk = file.chunks[index];
    if (!chunk || chunk.idx !== index || !isBase64(chunk.iv, 256)) return false;
    const maxEncodedChunkLength = Math.ceil((MAX_FILE_CHUNK_BYTES + 16) * 4 / 3) + 4;
    if (!isBase64(chunk.ct, maxEncodedChunkLength)) return false;
    const normalized = chunk.ct.replace(/-/g, '+').replace(/_/g, '/');
    const ciphertextBytes = Math.floor(normalized.length * 3 / 4) - (normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0);
    const plaintextBytes = ciphertextBytes - 16; // AES-GCM authentication tag
    if (plaintextBytes < 0 || plaintextBytes > MAX_FILE_CHUNK_BYTES) return false;
    decryptedSize += plaintextBytes;
  }

  return decryptedSize === file.size;
}

function isValidEncryptedPayload(payload, socket, room) {
  if (!payload || typeof payload !== 'object' || payload.v !== 1) return false;
  if (!isValidId(payload.id) || payload.from !== socket.id || typeof payload.to !== 'string') return false;
  if (!room.users.has(payload.to) || payload.to === socket.id) return false;
  if (payload.file) return isValidFilePayload(payload.file);
  return isBase64(payload.ct) && isBase64(payload.iv, 256) && isBase64(payload.salt, 256);
}

function pendingList(room) {
  return Array.from(room.pending.values()).map((p) => ({ requestId: p.requestId, username: p.username }));
}

function isHost(room, socket) {
  return Boolean(room && room.hostId && room.hostId === socket.id && room.users.has(socket.id));
}

io.on('connection', (socket) => {
  
  // -------------------------------------------------------------------------
  // Room lifecycle: create / request to join / host approval / rejoin
  // -------------------------------------------------------------------------

  socket.on('create-room', (data, callback) => {
    if (typeof callback !== 'function') return;
    try {
      const username = cleanName(data && data.username);
      if (!username) {
        return callback({ success: false, message: 'Invalid data' });
      }
      if (socket.roomId) handleLeave(true);
      if (socket.pendingRoomId) cancelPending(socket);

      let roomId = generateRoomCode();
      while (rooms.has(roomId)) {
        roomId = generateRoomCode();
      }

      const hostToken = newToken();
      const room = {
        code: roomId,
        users: new Map(),
        game: null,
        hostId: socket.id,
        hostToken,
        members: new Map(),   // token -> { username } for every admitted participant
        pending: new Map(),   // requesterSocketId -> { requestId, username }
        emptyTimer: null,
        handoffTimer: null
      };
      rooms.set(roomId, room);

      room.users.set(socket.id, { id: socket.id, username, token: hostToken });

      socket.join(roomId);
      socket.roomId = roomId;

      console.log(`[ROOM CREATED] room=${roomId} hostSocket=${socket.id} hostName="${username}"`);

      callback({ success: true, roomCode: roomId, isHost: true, token: hostToken });

      broadcastUserList(roomId);
    } catch (err) {
      callback({ success: false, message: 'Server error creating room.' });
    }
  });

  // A person asks to join. They are NOT placed in the room until the host approves.
  socket.on('join-request', (data, callback) => {
    if (typeof callback !== 'function') callback = () => {};
    try {
      if (!data || !data.roomCode || !data.username) {
        return callback({ success: false, message: 'Invalid data' });
      }
      if (!checkRateLimit(socket)) {
        return callback({ success: false, message: 'Too many attempts. Please wait a moment.' });
      }

      const username = cleanName(data.username);
      const roomId = String(data.roomCode).trim();
      if (!username) return callback({ success: false, message: 'Invalid data' });
      if (!isValidRoomCode(roomId)) return callback({ success: false, message: 'Enter a valid six-digit room code' });

      const room = rooms.get(roomId);
      if (!room) return callback({ success: false, message: 'Room not found' });
      if (room.users.has(socket.id)) return callback({ success: false, message: 'You are already in this room' });

      if (socket.roomId) handleLeave(true);
      if (socket.pendingRoomId) cancelPending(socket);

      if (room.pending.size >= MAX_PENDING_PER_ROOM) {
        return callback({ success: false, message: 'Too many pending requests for this room. Try again shortly.' });
      }

      const request = { requestId: socket.id, username };
      room.pending.set(socket.id, request);
      socket.pendingRoomId = roomId;

      console.log(`[JOIN REQUEST] room=${roomId} requesterSocket=${socket.id} name="${username}" pendingNow=${room.pending.size}`);

      callback({ success: true, pending: true, roomCode: roomId });

      // Send ONLY to the host's socket (never to the room, the joiner is not in it yet).
      const hostSocket = room.hostId ? io.sockets.sockets.get(room.hostId) : null;
      if (hostSocket) {
        console.log(`[HOST FOUND] room=${roomId} hostSocket=${room.hostId}`);
        hostSocket.emit('join-request-received', {
          requestId: request.requestId,
          username: request.username,
          pending: pendingList(room)
        });
        console.log(`[REQUEST SENT] room=${roomId} hostSocket=${room.hostId} requestId=${request.requestId} name="${username}"`);
      } else {
        // Host is briefly offline (refresh/reconnect). The request stays queued and is
        // delivered when the host rejoins (rejoin-room callback) or a new host is promoted.
        console.log(`[HOST FOUND] room=${roomId} NO LIVE HOST SOCKET - request queued (hostId=${room.hostId})`);
      }
    } catch (err) {
      callback({ success: false, message: 'Server error requesting to join.' });
    }
  });

  // The old direct-join event is intentionally closed: nobody can skip host approval.
  socket.on('join-room', (data, callback) => {
    if (typeof callback === 'function') {
      callback({ success: false, message: 'Joining now needs host approval. Please refresh the page and try again.' });
    }
  });

  socket.on('cancel-join-request', () => {
    cancelPending(socket);
  });

  // Host-only: accept or reject a pending request. The server decides, never the client.
  const resolveJoinRequest = (data, approve) => {
    const room = socket.roomId ? rooms.get(socket.roomId) : null;
    if (!isHost(room, socket)) {
      console.log(`[JOIN REQUEST] DENIED: socket ${socket.id} is not the host of room ${socket.roomId || '(none)'}`);
      socket.emit('join-request-error', { message: 'Only the host can approve or reject requests.' });
      return;
    }
    const requestId = data && typeof data.requestId === 'string' ? data.requestId : '';
    const request = room.pending.get(requestId);
    if (!request) {
      socket.emit('join-requests-sync', pendingList(room));
      return;
    }
    room.pending.delete(requestId);

    const target = io.sockets.sockets.get(requestId);
    if (approve) console.log(`[REQUEST ACCEPTED] room=${room.code} host=${socket.id} requestId=${requestId} name="${request.username}"`);
    else console.log(`[REQUEST REJECTED] room=${room.code} host=${socket.id} requestId=${requestId} name="${request.username}"`);
    if (target) {
      target.pendingRoomId = null;
      if (approve) {
        admitUser(room, target, request.username);
      } else {
        target.emit('join-request-rejected', { roomCode: room.code, message: 'Host rejected your request' });
      }
    } else {
      console.log(`[JOIN REQUEST] requester ${requestId} is no longer connected`);
    }
    socket.emit('join-requests-sync', pendingList(room));
  };

  socket.on('join-request-approve', (data) => resolveJoinRequest(data, true));
  socket.on('join-request-reject', (data) => resolveJoinRequest(data, false));

  // Reconnect after a refresh. Requires the secret token issued at create/approval time.
  socket.on('rejoin-room', (data, callback) => {
    if (typeof callback !== 'function') return;
    try {
      if (!data || !data.roomCode || !data.token) {
        return callback({ success: false, message: 'Invalid data' });
      }

      const roomId = String(data.roomCode).trim();
      if (!isValidRoomCode(roomId)) return callback({ success: false, message: 'Enter a valid six-digit room code' });
      const room = rooms.get(roomId);
      if (!room) return callback({ success: false, message: 'Room not found' });

      const token = String(data.token);
      let username;
      let host = false;
      if (token === room.hostToken) {
        host = true;
        username = cleanName(data.username) || 'Host';
      } else if (room.members.has(token)) {
        username = room.members.get(token).username;
      } else {
        return callback({ success: false, message: 'Please request to join again.' });
      }

      if (socket.roomId && socket.roomId !== roomId) handleLeave(true);
      if (socket.pendingRoomId) cancelPending(socket);

      // Drop any stale entry for the same person (their old socket id).
      for (const [oldId, user] of Array.from(room.users.entries())) {
        if (user.token === token && oldId !== socket.id) {
          room.users.delete(oldId);
          io.to(roomId).emit('user-disconnected', { username: user.username, socketId: oldId });
          const oldSocket = io.sockets.sockets.get(oldId);
          if (oldSocket) { oldSocket.leave(roomId); oldSocket.roomId = null; }
        }
      }

      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;

      room.users.set(socket.id, { id: socket.id, username, token });
      socket.join(roomId);
      socket.roomId = roomId;

      if (host) {
        room.hostId = socket.id;
        clearTimeout(room.handoffTimer);
        room.handoffTimer = null;
      }

      callback({
        success: true,
        roomCode: roomId,
        isHost: host,
        username,
        token,
        pending: host ? pendingList(room) : undefined
      });

      socket.to(roomId).emit('user-connected', { username, socketId: socket.id });
      broadcastUserList(roomId);
      if (host) console.log(`[HOST FOUND] room=${roomId} host rejoined as socket=${socket.id}, queued requests=${room.pending.size}`);
    } catch (err) {
      callback({ success: false, message: 'Server error rejoining room.' });
    }
  });

  socket.on('chat-message', (payload) => {
    const room = socket.roomId ? rooms.get(socket.roomId) : null;
    if (!room) return;

    if (!checkRateLimit(socket)) {
      socket.emit('rate-limited');
      return;
    }

    if (!isValidEncryptedPayload(payload, socket, room)) return;
    if (JSON.stringify(payload).length > MAX_SOCKET_PAYLOAD_BYTES) return;

    io.to(payload.to).emit('chat-message', payload);
    socket.emit('message:delivered', { id: payload.id });
  });

  socket.on('message:seen', (payload) => {
    if (!socket.roomId || !payload || !isValidId(payload.id)) return;
    socket.to(socket.roomId).emit('message:seen', { id: payload.id });
  });

  socket.on('e2ee:public-key', (payload) => {
    if (!socket.roomId || !payload || !isBase64(payload.publicKey, 256)) return;
    socket.to(socket.roomId).emit('e2ee:public-key', {
      sender: socket.id,
      publicKey: payload.publicKey
    });
  });

  socket.on('webrtc:offer', (payload) => {
    if (!socket.roomId || !payload || !payload.target || !payload.offer) return;
    const room = rooms.get(socket.roomId);
    if (room && room.users.has(payload.target)) {
      io.to(payload.target).emit('webrtc:offer', { from: socket.id, offer: payload.offer });
    }
  });

  socket.on('webrtc:answer', (payload) => {
    if (!socket.roomId || !payload || !payload.target || !payload.answer) return;
    const room = rooms.get(socket.roomId);
    if (room && room.users.has(payload.target)) {
      io.to(payload.target).emit('webrtc:answer', { from: socket.id, answer: payload.answer });
    }
  });

  socket.on('webrtc:ice-candidate', (payload) => {
    if (!socket.roomId || !payload || !payload.target || !payload.candidate) return;
    const room = rooms.get(socket.roomId);
    if (room && room.users.has(payload.target)) {
      io.to(payload.target).emit('webrtc:ice-candidate', { from: socket.id, candidate: payload.candidate });
    }
  });

  socket.on('typing', (payload) => {
    const room = socket.roomId ? rooms.get(socket.roomId) : null;
    const user = room?.users.get(socket.id);
    if (!user) return;
    socket.to(socket.roomId).emit('typing', {
      sender: user.username,
      isTyping: Boolean(payload?.isTyping)
    });
  });

  socket.on('game:invite', (data) => {
    if (socket.roomId) socket.to(socket.roomId).emit('game:invite', data);
  });
  
  socket.on('game:accept', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);
    const players = Array.from(room.users.values()).slice(0, 2);
    if (players.length !== 2) return;

    room.game = {
      id: data.gameId,
      playerIds: players.map(player => player.id),
      players: players.map(player => player.username),
      moves: new Map(),
      board: Array(9).fill(null),
      turn: 0
    };

    io.to(socket.roomId).emit('game:start', { gameId: data.gameId, players: room.game.players });
  });
  
  socket.on('game:decline', (data) => {
    if (socket.roomId) socket.to(socket.roomId).emit('game:decline', data);
  });

  socket.on('game:move', (data) => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);
    const game = room.game;
    const user = room.users.get(socket.id);

    if (!game || !user || game.id !== data.gameId || !game.playerIds.includes(socket.id)) return;

    if (data.gameId === 'race') {
      if (data.type === 'finish') {
        io.to(socket.roomId).emit('game:result', { gameId: 'race', winner: user.username });
        room.game = null;
      } else {
        socket.to(socket.roomId).emit('game:move', data);
      }
      return;
    }

    if (data.gameId === 'rps') {
      if (!['rock', 'paper', 'scissors'].includes(data.move) || game.moves.has(socket.id)) return;
      game.moves.set(socket.id, data.move);

      if (game.moves.size === 2) {
        const [firstId, secondId] = game.playerIds;
        const firstMove = game.moves.get(firstId);
        const secondMove = game.moves.get(secondId);
        const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
        const winner = firstMove === secondMove
          ? 'draw'
          : beats[firstMove] === secondMove
            ? game.players[0]
            : game.players[1];
        io.to(socket.roomId).emit('game:result', { gameId: 'rps', winner });
        room.game = null;
      }
      return;
    }

    if (data.gameId === 'tap') {
      const reactionTime = Number(data.move);
      if (!Number.isFinite(reactionTime) || reactionTime < 0 || game.moves.has(socket.id)) return;
      game.moves.set(socket.id, reactionTime);

      if (game.moves.size === 2) {
        const [firstId, secondId] = game.playerIds;
        const firstTime = game.moves.get(firstId);
        const secondTime = game.moves.get(secondId);
        const winner = firstTime === secondTime
          ? 'draw'
          : firstTime < secondTime
            ? game.players[0]
            : game.players[1];
        io.to(socket.roomId).emit('game:result', {
          gameId: 'tap',
          winner,
          winningScore: Math.min(firstTime, secondTime)
        });
        room.game = null;
      }
      return;
    }

    if (data.gameId === 'ttt') {
      const cell = Number(data.move);
      if (!Number.isInteger(cell) || cell < 0 || cell > 8 || game.board[cell] || game.playerIds[game.turn] !== socket.id) return;

      game.board[cell] = socket.id;
      io.to(socket.roomId).emit('game:state', { gameId: 'ttt', move: cell, player: user.username });

      const winningLines = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
      ];
      const won = winningLines.some(([a, b, c]) => game.board[a] === socket.id && game.board[b] === socket.id && game.board[c] === socket.id);

      if (won) {
        io.to(socket.roomId).emit('game:result', { gameId: 'ttt', winner: user.username });
        room.game = null;
      } else if (game.board.every(Boolean)) {
        io.to(socket.roomId).emit('game:result', { gameId: 'ttt', winner: 'draw' });
        room.game = null;
      } else {
        game.turn = (game.turn + 1) % 2;
        io.to(socket.roomId).emit('game:turn', { gameId: 'ttt', username: game.players[game.turn] });
      }
    }
  });

  socket.on('game:quit', () => {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    rooms.get(socket.roomId).game = null;
    socket.to(socket.roomId).emit('game:quit');
  });

  function handleLeave(explicit) {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) { socket.roomId = null; return; }

    const room = rooms.get(roomId);
    const user = room.users.get(socket.id);

    if (user) {
      io.to(roomId).emit('user-disconnected', { username: user.username, socketId: socket.id });

      room.users.delete(socket.id);
      socket.leave(roomId);

      const wasHost = room.hostId === socket.id;
      if (wasHost) room.hostId = null;

      if (room.users.size === 0) {
        if (explicit) {
          closeRoom(room, 'This room was closed.');
        } else {
          // Keep it briefly so a refresh / reconnect can get back in.
          clearTimeout(room.emptyTimer);
          room.emptyTimer = setTimeout(() => closeRoom(room, 'This room is no longer available.'), ROOM_EMPTY_GRACE_MS);
        }
      } else {
        if (wasHost) {
          if (explicit) promoteNewHost(room);
          else {
            clearTimeout(room.handoffTimer);
            room.handoffTimer = setTimeout(() => promoteNewHost(room), HOST_HANDOFF_GRACE_MS);
          }
        }
        broadcastUserList(roomId);
      }
    }
    socket.roomId = null;
  }

  socket.on('leave-room', () => {
    handleLeave(true);
    cancelPending(socket);
    cleanRateLimit(socket.id);
    socket.emit('left-room');
  });

  socket.on('disconnect', () => {
    handleLeave(false);
    cancelPending(socket);
    cleanRateLimit(socket.id);
  });
});

// ---------------------------------------------------------------------------
// Room-level helpers (module scope)
// ---------------------------------------------------------------------------

function broadcastUserList(roomId) {
  if (!rooms.has(roomId)) return;
  const room = rooms.get(roomId);

  const userList = Array.from(room.users.values()).map((user) => ({
    id: user.id,
    username: user.username,
    isHost: user.id === room.hostId
  }));

  io.to(roomId).emit('update-users', userList);
}

// Put an approved requester into the room. Only ever called from the host-checked path.
function admitUser(room, target, username) {
  const token = newToken();
  room.members.set(token, { username });
  room.users.set(target.id, { id: target.id, username, token });

  target.join(room.code);
  target.roomId = room.code;

  target.emit('join-request-approved', { roomCode: room.code, token });
  console.log(`[JOINER ADMITTED] room=${room.code} socket=${target.id} name="${username}"`);
  target.to(room.code).emit('user-connected', { username, socketId: target.id });
  broadcastUserList(room.code);
}

// Withdraw a socket's pending request (user cancelled, disconnected, or re-requested).
function cancelPending(socket) {
  const roomId = socket.pendingRoomId;
  socket.pendingRoomId = null;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || !room.pending.delete(socket.id)) return;
  if (room.hostId) {
    io.to(room.hostId).emit('join-request-cancelled', { requestId: socket.id, pending: pendingList(room) });
  }
}

// Give host rights to the longest-present participant when the host is gone.
function promoteNewHost(room) {
  clearTimeout(room.handoffTimer);
  room.handoffTimer = null;
  if (!rooms.has(room.code)) return;
  if (room.hostId && room.users.has(room.hostId)) return; // host is back
  const next = room.users.values().next().value;
  if (!next) return;

  room.hostToken = newToken();
  room.hostId = next.id;
  next.token = room.hostToken;
  io.to(next.id).emit('host-changed', { token: room.hostToken, pending: pendingList(room) });
  io.to(room.code).emit('system-message', `${next.username} is now the host`);
  broadcastUserList(room.code);
}

// Remove a room and tell anyone still waiting at the door.
function closeRoom(room, message) {
  clearTimeout(room.emptyTimer);
  clearTimeout(room.handoffTimer);
  for (const requestId of room.pending.keys()) {
    const waiting = io.sockets.sockets.get(requestId);
    if (waiting) {
      waiting.pendingRoomId = null;
      waiting.emit('join-request-rejected', { roomCode: room.code, message });
    }
  }
  room.pending.clear();
  rooms.delete(room.code);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Chatting app server running on http://localhost:${PORT}`);
  console.log(`🔌 Socket.IO server ready`);
});

server.on("error", (error) => {
  console.error("❌ Server error:", error);
});
