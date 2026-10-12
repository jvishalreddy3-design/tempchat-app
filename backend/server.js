const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));

const rooms = new Map();
const rateLimits = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
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

io.on('connection', (socket) => {
  
  socket.on('create-room', (data, callback) => {
    try {
      if (!data || !data.username) {
        return callback({ success: false, message: 'Invalid data' });
      }
      let roomId = generateRoomCode();
      while (rooms.has(roomId)) {
        roomId = generateRoomCode();
      }

      rooms.set(roomId, {
        code: roomId,
        users: new Map(),
        game: null
      });

      const userState = { id: socket.id, username: data.username };
      rooms.get(roomId).users.set(socket.id, userState);

      socket.join(roomId);
      socket.roomId = roomId;

      callback({ success: true, roomCode: roomId });
      
      broadcastUserList(roomId);
    } catch (err) {
      callback({ success: false, message: 'Server error creating room.' });
    }
  });

  socket.on('join-room', (data, callback) => {
    try {
      if (!data || !data.roomCode || !data.username) {
        return callback({ success: false, message: 'Invalid data' });
      }

      const normalizedRoomId = data.roomCode.trim().toUpperCase();

      if (!rooms.has(normalizedRoomId)) {
        return callback({ success: false, message: 'Room not found' });
      }

      const userState = { id: socket.id, username: data.username };
      rooms.get(normalizedRoomId).users.set(socket.id, userState);

      socket.join(normalizedRoomId);
      socket.roomId = normalizedRoomId;

      callback({ success: true, roomCode: normalizedRoomId });

      socket.to(normalizedRoomId).emit('user-connected', { username: data.username, socketId: socket.id });
      
      broadcastUserList(normalizedRoomId);
    } catch (err) {
      callback({ success: false, message: 'Server error joining room.' });
    }
  });

  socket.on('rejoin-room', (data, callback) => {
    try {
      if (!data || !data.roomCode || !data.username) {
        return callback({ success: false, message: 'Invalid data' });
      }

      const normalizedRoomId = data.roomCode.trim().toUpperCase();

      if (!rooms.has(normalizedRoomId)) {
        return callback({ success: false, message: 'Room not found' });
      }

      const userState = { id: socket.id, username: data.username };
      rooms.get(normalizedRoomId).users.set(socket.id, userState);

      socket.join(normalizedRoomId);
      socket.roomId = normalizedRoomId;

      callback({ success: true, roomCode: normalizedRoomId });

      socket.to(normalizedRoomId).emit('user-connected', { username: data.username, socketId: socket.id });
      
      broadcastUserList(normalizedRoomId);
    } catch (err) {
      callback({ success: false, message: 'Server error rejoining room.' });
    }
  });

  socket.on('chat-message', (payload) => {
    if (!socket.roomId || !payload) return;
    
    if (JSON.stringify(payload).length > 65536) return;

    if (!checkRateLimit(socket)) {
      socket.emit('rate-limited');
      return;
    }

    if (payload.id) {
      socket.to(socket.roomId).emit('chat-message', payload);
      socket.emit('message:delivered', { id: payload.id });
    }
  });

  socket.on('message:seen', (payload) => {
    if (!socket.roomId || !payload || !payload.id) return;
    socket.to(socket.roomId).emit('message:seen', { id: payload.id });
  });

  socket.on('e2ee:public-key', (payload) => {
    if (!socket.roomId || !payload || !payload.publicKey) return;
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
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('typing', {
      sender: String(payload?.sender || ''),
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

  const handleLeave = () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const user = room.users.get(socket.id);
    
    if (user) {
      io.to(roomId).emit('user-disconnected', { username: user.username, socketId: socket.id });
      
      room.users.delete(socket.id);
      socket.leave(roomId);
      
      if (room.users.size === 0) {
        rooms.delete(roomId);
      } else {
        broadcastUserList(roomId);
      }
    }
    socket.roomId = null;
  };

  socket.on('leave-room', () => {
    handleLeave();
    cleanRateLimit(socket.id);
    socket.emit('left-room');
  });

  socket.on('disconnect', () => {
    handleLeave();
    cleanRateLimit(socket.id);
  });

  function broadcastUserList(roomId) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    
    const userList = Array.from(room.users.values()).map(user => ({
      id: user.id,
      username: user.username
    }));

    io.to(roomId).emit('update-users', userList);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Chatting app server running on http://localhost:${PORT}`);
  console.log(`🔌 Socket.IO server ready`);
});

server.on("error", (error) => {
  console.error("❌ Server error:", error);
});
