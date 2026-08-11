const mongoose = require("mongoose");

// Conversation identity and message shaping used by the REST controller, the
// socket handlers, and the bargaining flow. These lived in three near-identical
// copies before; keep them here so the thread rules can never drift apart.

const makeConversationId = ({ userA, userB }) => {
  return `${[userA.toString(), userB.toString()].sort().join("_")}_general`;
};

const parseConversationParticipants = (conversationId = "") => {
  const [firstId, secondId, suffix] = String(conversationId).split("_");
  if (suffix !== "general") return null;
  if (!mongoose.Types.ObjectId.isValid(firstId) || !mongoose.Types.ObjectId.isValid(secondId)) return null;
  return [firstId, secondId];
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

function emitChatEvent(room, event, payload) {
  try {
    const { getIO } = require("../config/socket");
    const io = typeof getIO === "function" ? getIO() : null;
    const rooms = Array.isArray(room)
      ? room.map((value) => value?.toString()).filter(Boolean)
      : room?.toString();
    if (io && (Array.isArray(rooms) ? rooms.length : rooms)) io.to(rooms).emit(event, payload);
  } catch {
    // Realtime delivery is best-effort; REST still returns the saved message.
  }
}

module.exports = {
  emitChatEvent,
  idValue,
  makeConversationId,
  messagePopulate,
  parseConversationParticipants,
  participantFilter,
};
