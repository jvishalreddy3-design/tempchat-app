'use strict';

const crypto = require('node:crypto');

const PRIVATE_MAX_CONVERSATIONS = 250;
const PRIVATE_MAX_MESSAGES_PER_CONVERSATION = 100;
const PRIVATE_MAX_TEXT_LENGTH = 4000;
const PRIVATE_MAX_BUFFERED_CHARS = 8 * 1024 * 1024;
const PRIVATE_SEND_RATE_LIMIT = 30;
const PRIVATE_SEND_RATE_WINDOW_MS = 10000;

function installSocialSockets(io, store, accountService, options = {}) {
  const activeSocketsByUser = new Map();
  const conversations = new Map();       // conversationId -> { messages: [] } (active session cache)
  const conversationByPair = new Map();       // pairKey -> conversationId (active sessions only)
  const inactiveTimers = new Map();
  const privateRateLimits = new Map();
  let totalBufferedChars = 0;
  const now = options.now || Date.now;

  const accountSockets = (userId) => activeSocketsByUser.get(userId) || new Set();
  function emitPresence(userId, online) {
    for (const socketId of accountSockets(userId)) io.to(socketId).emit('friends:presence', { userId, online, observedAt: new Date(now()).toISOString() });
  }
  async function publishPresenceToFriends(userId, online) {
    const friends = await store.listFriends(userId);
    for (const friend of friends) emitPresence(friend._id, online);
  }

  // Ensure a conversation exists in MongoDB for a friend pair, returning its doc.
  async function ensureMongoConversation(pairKey, userIds) {
    let doc = await store.getPrivateConversation(pairKey);
    if (!doc) {
      doc = await store.createPrivateConversation(userIds, pairKey);
    }
    return doc;
  }

  // Build the list result entry for a conversation from MongoDB docs.
  async function buildListEntry(conversationDoc, userId) {
    const friendId = conversationDoc.userIds.find((id) => id !== userId);
    const friend = await store.findUserById(friendId);
    if (!friend || !(await store.areFriends(userId, friendId))) return null;

    const messages = await store.getPrivateMessages(conversationDoc._id, 1);
    const last = messages[0] || null;

    // Count messages not yet delivered to this user
    const allMessages = await store.getPrivateMessages(conversationDoc._id, PRIVATE_MAX_MESSAGES_PER_CONVERSATION);
    const unreadCount = allMessages.filter((m) => !Array.isArray(m.deliveredTo) || !m.deliveredTo.includes(userId)).length;

    return {
      id: conversationDoc._id,
      friendId,
      friendName: friend.displayName || friend.username,
      friendAvatar: friend.avatarUrl || null,
      online: accountSockets(friendId).size > 0,
      lastMessage: last ? { text: last.text, timestamp: last.timestamp.getTime ? last.timestamp.getTime() : new Date(last.timestamp).getTime() } : null,
      unreadCount: Math.max(0, unreadCount)
    };
  }

  // Deliver any messages that were stored while the recipient was offline.
  async function deliverOfflineMessages(socket, userId) {
    try {
      const undelivered = await store.getUndeliveredMessagesForUser(userId);
      if (!undelivered.length) return;

      // Group by conversation so we only emit once per conversation
      const byConv = new Map();
      for (const m of undelivered) {
        if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
        byConv.get(m.conversationId).push(m);
      }

      for (const [conversationId, messages] of byConv.entries()) {
        // Mark delivered in DB
        await store.markConversationMessagesDelivered(conversationId, userId);
        socket.emit('private:offline-messages', {
          conversationId,
          messages: messages.map((m) => ({
            id: m._id,
            conversationId: m.conversationId,
            from: m.from,
            sender: m.sender,
            text: m.text,
            timestamp: m.timestamp.getTime ? m.timestamp.getTime() : new Date(m.timestamp).getTime()
          }))
        });
        io.to(`account:${userId}`).emit('private:list-updated');
      }
    } catch (_) {
      // Offline delivery is best-effort; history can be fetched on demand.
    }
  }

  function maybeScheduleCleanup(conversationId) {
    const oldTimer = inactiveTimers.get(conversationId);
    if (oldTimer) clearTimeout(oldTimer);
    inactiveTimers.delete(conversationId);
    const timer = setTimeout(() => removeConversation(conversationId), options.privateTtlMs || PRIVATE_TTL_MS);
    timer.unref?.();
    inactiveTimers.set(conversationId, timer);
  }
  function removeConversation(conversationId) {
    const timer = inactiveTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    inactiveTimers.delete(conversationId);
    conversationByPair.delete(conversationId);
    conversations.delete(conversationId);
  }
  function pruneOldInactive() {
    // In-memory active-session cap only; MongoDB retains history forever.
    if (conversationByPair.size < PRIVATE_MAX_CONVERSATIONS) return true;
    // No in-memory conversation objects to prune; just return true so new convos can be created.
    return true;
  }
  function leaveConversation(socket, conversationId) {
    socket.privateConversationIds?.delete(conversationId);
    socket.leave(`private:${conversationId}`);
    maybeScheduleCleanup(conversationId);
  }
  function leaveAll(socket) {
    for (const id of [...(socket.privateConversationIds || [])]) leaveConversation(socket, id);
  }

  io.on('connection', (socket) => {
    const user = socket.accountUser;
    if (!user) return;
    let sockets = activeSocketsByUser.get(user.id);
    const wasOnline = Boolean(sockets?.size);
    if (!sockets) activeSocketsByUser.set(user.id, sockets = new Set());
    sockets.add(socket.id);
    socket.join(`account:${user.id}`);
    if (socket.accountAuthExpiresAt) {
      const wait = Math.max(0, socket.accountAuthExpiresAt - now());
      const timer = setTimeout(() => socket.disconnect(true), wait);
      timer.unref?.();
      socket.once('disconnect', () => clearTimeout(timer));
    }

    // Deliver any messages that arrived while this user was offline.
    deliverOfflineMessages(socket, user.id).catch((error) => console.error('[social] offline delivery failed:', error.code || error.name));

    store.listFriends(user.id).then((friends) => {
      socket.emit('social:ready', {
        user: { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl },
        friends: friends.map((friend) => ({ id: friend._id, username: friend.username, displayName: friend.displayName, avatarUrl: friend.avatarUrl || null, online: accountSockets(friend._id).size > 0 }))
      });
      if (!wasOnline) return publishPresenceToFriends(user.id, true);
    }).catch((error) => console.error('[social] presence initialization failed:', error.code || error.name));

    socket.on('private:open', async (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      try {
        if (!socket.accountUser || typeof payload?.friendId !== 'string' || payload.friendId === socket.accountUser.id) throw new Error('A valid friend is required.');
        if (!(await store.areFriends(socket.accountUser.id, payload.friendId))) throw new Error('Private chats are available only between accepted friends.');
        const pairKey = store.pairKey(socket.accountUser.id, payload.friendId);
        const doc = await ensureMongoConversation(pairKey, [socket.accountUser.id, payload.friendId]);

        // Track active session for this conversation
        conversationByPair.set(pairKey, doc._id);

        const pending = inactiveTimers.get(doc._id);
        if (pending) clearTimeout(pending);
        inactiveTimers.delete(doc._id);

        socket.privateConversationIds ||= new Set();
        socket.privateConversationIds.add(doc._id);
        socket.join(`private:${doc._id}`);

        const history = await store.getPrivateMessages(doc._id, PRIVATE_MAX_MESSAGES_PER_CONVERSATION);

        // Mark messages in this conversation as delivered to this user now that they're online.
        await store.markConversationMessagesDelivered(doc._id, socket.accountUser.id);

        acknowledge({
          success: true,
          conversation: {
            id: doc._id,
            peerId: payload.friendId,
            peerOnline: accountSockets(payload.friendId).size > 0,
            messages: history.map((m) => ({
              id: m._id,
              conversationId: m.conversationId,
              from: m.from,
              sender: m.sender,
              text: m.text,
              timestamp: m.timestamp.getTime ? m.timestamp.getTime() : new Date(m.timestamp).getTime()
            }))
          }
        });
      } catch (error) {
        acknowledge({ success: false, message: error.message });
      }
    });

    socket.on('private:leave', (payload) => {
      if (typeof payload?.conversationId === 'string') leaveConversation(socket, payload.conversationId);
    });

    socket.on('private:list', async (_payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      try {
        const conversations = await store.getPrivateConversationsForUser(user.id);
        const entries = [];
        for (const doc of conversations) {
          const entry = await buildListEntry(doc, user.id);
          if (entry) entries.push(entry);
        }
        entries.sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
        acknowledge({ success: true, conversations: entries });
      } catch (_) {
        acknowledge({ success: false, conversations: [], message: 'Unable to load active conversations.' });
      }
    });

    socket.on('private:send', async (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      const senderId = user.id;

      try {
        if (typeof payload?.conversationId !== 'string' || !socket.privateConversationIds?.has(payload.conversationId)) {
          acknowledge({ success: false, delivered: false, reason: 'unauthorized' });
          return;
        }
        if (typeof payload?.id !== 'string' || !/^[A-Za-z0-9_-]{12,96}$/.test(payload.id) || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > PRIVATE_MAX_TEXT_LENGTH) {
          acknowledge({ success: false, delivered: false, reason: 'invalid_message' });
          return;
        }

        const rate = privateRateLimits.get(senderId);
        const timestamp = now();
        if (!rate || timestamp - rate.startedAt >= PRIVATE_SEND_RATE_WINDOW_MS) privateRateLimits.set(senderId, { startedAt: timestamp, count: 1 });
        else if (++rate.count > PRIVATE_SEND_RATE_LIMIT) { acknowledge({ success: false, delivered: false, reason: 'rate_limited' }); return; }

        const conversationDoc = await store.getPrivateConversationById(payload.conversationId);
        if (!conversationDoc || !conversationDoc.userIds.includes(senderId)) {
          acknowledge({ success: false, delivered: false, reason: 'unauthorized' });
          return;
        }
        const peerId = conversationDoc.userIds.find((id) => id !== senderId);
        if (!(await store.areFriends(senderId, peerId))) {
          leaveConversation(socket, payload.conversationId);
          acknowledge({ success: false, delivered: false, reason: 'friendship_required' });
          return;
        }

        // Prevent duplicate message id
        const existing = await store.findPrivateMessageById(payload.id);
        if (existing) {
          acknowledge({ success: true, delivered: true, duplicate: true, id: payload.id });
          return;
        }

        const message = {
          id: payload.id,
          conversationId: payload.conversationId,
          from: senderId,
          sender: user.displayName || user.username,
          text: payload.text.trim(),
          timestamp: timestamp
        };

        // Capacity guard
        if (totalBufferedChars + message.text.length > PRIVATE_MAX_BUFFERED_CHARS) {
          acknowledge({ success: false, delivered: false, reason: 'memory_capacity' });
          return;
        }

        // Persist to PostgreSQL first
        await store.savePrivateMessage(payload.conversationId, message);
        totalBufferedChars += message.text.length;

        // Cache in active session map for test compatibility
        let convCache = conversations.get(payload.conversationId);
        if (!convCache) {
          convCache = { messages: [] };
          conversations.set(payload.conversationId, convCache);
        }
        convCache.messages.push(message);
        while (convCache.messages.length > PRIVATE_MAX_MESSAGES_PER_CONVERSATION) {
          convCache.messages.shift();
        }

        const recipientSockets = [...accountSockets(peerId)];
        if (!recipientSockets.length) {
          // Stored for later delivery; acknowledge as not delivered yet but stored.
          acknowledge({ success: true, delivered: false, reason: 'recipient_offline', stored: true, id: payload.id });
          io.to(`account:${senderId}`).emit('private:list-updated');
          return;
        }

        let remaining = recipientSockets.length;
        let delivered = false;
        let settled = false;
        const finish = () => {
          if (settled || --remaining > 0) return;
          settled = true;
          acknowledge({ success: delivered, delivered, reason: delivered ? undefined : 'recipient_unavailable', id: payload.id });
          if (delivered) {
            io.to(`account:${senderId}`).emit('private:list-updated');
            io.to(`account:${peerId}`).emit('private:list-updated');
          }
        };
        for (const recipientSocketId of recipientSockets) {
          io.to(recipientSocketId).timeout(5000).emit('private:message', message, (error, responses) => {
            if (!error && Array.isArray(responses) && responses.some((response) => response?.received === true)) delivered = true;
            finish();
          });
        }
      } catch (error) {
        acknowledge({ success: false, delivered: false, reason: 'server_error', message: 'Unable to send message.' });
      }
    });

    socket.on('disconnect', () => {
      leaveAll(socket);
      const current = activeSocketsByUser.get(user.id);
      if (!current) return;
      current.delete(socket.id);
      if (current.size === 0) {
        activeSocketsByUser.delete(user.id);
        privateRateLimits.delete(user.id);
        publishPresenceToFriends(user.id, false).catch((error) => console.error('[social] presence update failed:', error.code || error.name));
      }
    });
  });

  return {
    activeSocketsByUser,
    conversations,
    dispose: () => { for (const timer of inactiveTimers.values()) clearTimeout(timer); inactiveTimers.clear(); conversationByPair.clear(); conversations.clear(); activeSocketsByUser.clear(); privateRateLimits.clear(); totalBufferedChars = 0; }
  };
}

module.exports = { installSocialSockets, PRIVATE_MAX_CONVERSATIONS, PRIVATE_MAX_MESSAGES_PER_CONVERSATION };