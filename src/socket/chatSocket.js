const Message = require("../models/Message");
const { makeConversationId } = require("../controllers/chatController");

const parseConversationParticipants = (conversationId = "") => {
  const [firstId, secondId, suffix] = String(conversationId).split("_");
  if (suffix !== "general") return null;
  return firstId && secondId ? [firstId, secondId] : null;
};

const idValue = (value) => {
  if (!value) return "";
  if (value._id) return value._id.toString();
  return value.toString();
};

const participantFilter = (conversationId, userId) => {
  const participants = parseConversationParticipants(conversationId);
  if (!participants || !participants.includes(userId)) {
    return {
      conversationId,
      $or: [{ senderId: userId }, { receiverId: userId }],
    };
  }

  const [firstId, secondId] = participants;
  return {
    $or: [
      { senderId: firstId, receiverId: secondId },
      { senderId: secondId, receiverId: firstId },
    ],
  };
};

const messagePopulate = (userSelect = "name username profilePhoto") => [
  { path: "senderId", select: userSelect },
  { path: "receiverId", select: userSelect },
  { path: "listingId", select: "title images price currency" },
  { path: "reactions.userId", select: "name username profilePhoto" },
  {
    path: "replyTo",
    select: "content attachments listingId senderId createdAt",
    populate: [
      { path: "senderId", select: "name username profilePhoto" },
      { path: "listingId", select: "title images price currency" },
    ],
  },
];

const resolveReceiver = async ({ conversationId, receiverId, userId }) => {
  if (!conversationId) return receiverId;

  const latestMessage = await Message.findOne(participantFilter(conversationId, userId)).sort({ createdAt: -1 });

  if (latestMessage) {
    return latestMessage.senderId.toString() === userId
      ? latestMessage.receiverId.toString()
      : latestMessage.senderId.toString();
  }

  const participants = parseConversationParticipants(conversationId);
  if (participants?.includes(userId)) {
    return participants.find((participantId) => participantId !== userId);
  }

  return receiverId;
};

const registerChatSocket = (io, socket) => {
  socket.on("join_conversation", ({ conversationId }) => {
    if (conversationId) socket.join(conversationId);
  });

  const handleSendMessage = async (payload = {}, callback) => {
    try {
      const content = String(payload.content || "").trim();
      if (!content) throw new Error("Message text is required");

      const receiverId = await resolveReceiver({
        conversationId: payload.conversationId,
        receiverId: payload.receiverId,
        userId: socket.user.id,
      });

      if (!receiverId) throw new Error("A receiver is required");
      if (receiverId.toString() === socket.user.id) throw new Error("You cannot message yourself");

      const conversationId = parseConversationParticipants(payload.conversationId)?.includes(socket.user.id)
        ? payload.conversationId
        : makeConversationId({
            userA: socket.user.id,
            userB: receiverId,
          });

      const message = await Message.create({
        conversationId,
        senderId: socket.user.id,
        receiverId,
        listingId: payload.listingId,
        content,
        replyTo: payload.replyTo,
        type: "text",
      });

      await message.populate(messagePopulate(payload.listingId ? "name username profilePhoto phone" : "name username profilePhoto"));

      const event = {
        clientMessageId: payload.clientMessageId || "",
        conversationId,
        message,
      };

      io.to(receiverId.toString()).emit("new-message", event);
      io.to(socket.user.id).emit("message-confirmed", event);

      if (callback) callback({ success: true, ...event });
    } catch (error) {
      if (callback) callback({ success: false, error: error.message });
    }
  };

  socket.on("send-message", handleSendMessage);
  socket.on("send_message", handleSendMessage);

  socket.on("typing", ({ conversationId }) => {
    if (conversationId) {
      socket.to(conversationId).emit("user_typing", { userId: socket.user.id });
    }
  });

  const handleMarkRead = async ({ conversationId, senderId }) => {
    if (!conversationId) return;

    await Message.updateMany(
      {
        conversationId,
        receiverId: socket.user.id,
      },
      { isRead: true },
    );

    const event = {
      conversationId,
      readBy: socket.user.id,
    };
    const participants = parseConversationParticipants(conversationId) || [];
    const targets = senderId
      ? [senderId.toString()]
      : participants.filter((participantId) => participantId !== socket.user.id);

    targets.forEach((targetId) => {
      io.to(targetId.toString()).emit("messages_read", event);
      io.to(targetId.toString()).emit("messages-read", event);
    });
  };

  socket.on("mark-read", handleMarkRead);
  socket.on("mark_read", handleMarkRead);
};

module.exports = registerChatSocket;
