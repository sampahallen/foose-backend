const Message = require("../models/Message");
const Notification = require("../models/Notification");
const { makeConversationId } = require("../controllers/chatController");

const registerChatSocket = (io, socket) => {
  socket.on("join_conversation", ({ conversationId }) => {
    if (conversationId) socket.join(conversationId);
  });

  socket.on("send_message", async (payload, callback) => {
    try {
      const conversationId =
        payload.conversationId ||
        makeConversationId({
          userA: socket.user.id,
          userB: payload.receiverId,
          listingId: payload.listingId,
        });

      const message = await Message.create({
        conversationId,
        senderId: socket.user.id,
        receiverId: payload.receiverId,
        listingId: payload.listingId,
        content: payload.content,
        type: payload.type || "text",
      });

      const notification = await Notification.create({
        userId: payload.receiverId,
        type: "chat",
        title: "New message",
        body: payload.content || "You have a new message",
        link: `/chat/${conversationId}`,
      });

      io.to(payload.receiverId.toString()).emit("new_message", message);
      io.to(payload.receiverId.toString()).emit("notification", notification);
      io.to(conversationId).emit("conversation_message", message);

      if (callback) callback({ success: true, message });
    } catch (error) {
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on("typing", ({ conversationId }) => {
    if (conversationId) {
      socket.to(conversationId).emit("user_typing", { userId: socket.user.id });
    }
  });

  socket.on("mark_read", async ({ conversationId, senderId }) => {
    if (!conversationId) return;

    await Message.updateMany(
      {
        conversationId,
        receiverId: socket.user.id,
      },
      { isRead: true },
    );

    if (senderId) {
      io.to(senderId.toString()).emit("messages_read", {
        conversationId,
        readBy: socket.user.id,
      });
    }
  });
};

module.exports = registerChatSocket;
