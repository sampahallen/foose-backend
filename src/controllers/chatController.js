const mongoose = require("mongoose");
const Message = require("../models/Message");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");
const httpError = require("../utils/httpError");
const { createNotification } = require("../services/notificationService");

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

const attachmentType = (mimetype = "") => (mimetype.startsWith("video/") ? "video" : "image");

const messageType = (attachments) => {
  const types = new Set(attachments.map((attachment) => attachment.type));
  if (types.size > 1) return "mixed";
  return types.values().next().value || "text";
};

const pageOptions = (query, fallbackLimit = 40) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || fallbackLimit), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
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
    if (io) io.to(room.toString()).emit(event, payload);
  } catch {
    // Realtime delivery is best-effort; REST still returns the saved message.
  }
}

exports.listConversations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req.query, 40);
  const userObjectId = new mongoose.Types.ObjectId(req.user.id);
  const match = {
    $or: [{ senderId: userObjectId }, { receiverId: userObjectId }],
  };
  const countRows = await Message.aggregate([
    { $match: match },
    {
      $addFields: {
        participantId: {
          $cond: [{ $eq: ["$senderId", userObjectId] }, "$receiverId", "$senderId"],
        },
      },
    },
    { $group: { _id: "$participantId" } },
    { $count: "total" },
  ]);
  const total = countRows[0]?.total || 0;
  const rows = await Message.aggregate([
    { $match: match },
    {
      $addFields: {
        participantId: {
          $cond: [{ $eq: ["$senderId", userObjectId] }, "$receiverId", "$senderId"],
        },
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$participantId",
        latestMessage: { $first: "$$ROOT" },
        unreadCount: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$receiverId", userObjectId] },
                  { $eq: ["$isRead", false] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { "latestMessage.createdAt": -1 } },
    { $skip: skip },
    { $limit: limit },
  ]);

  const latestMessages = await Message.populate(
    rows.map((row) => row.latestMessage),
    messagePopulate(),
  );

  const conversations = rows.map((row, index) => {
    const latestMessage = latestMessages[index];
    const senderId = idValue(latestMessage.senderId);
    const participant =
      senderId === req.user.id ? latestMessage.receiverId : latestMessage.senderId;

    return {
      conversationId: makeConversationId({ userA: req.user.id, userB: row._id }),
      latestMessage,
      unreadCount: row.unreadCount,
      participant,
      listing: latestMessage.listingId,
    };
  });

  return success(res, { conversations, total, page, pages: Math.ceil(total / limit) }, "Conversations loaded");
});

exports.listConversation = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req.query, 30);
  const filter = participantFilter(req.params.conversationId, req.user.id);
  const [messages, total] = await Promise.all([
    Message.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Message.countDocuments(filter),
  ]);

  const hasProductContext = messages.some((message) => Boolean(message.listingId));
  const userSelect = hasProductContext
    ? "name username profilePhoto phone"
    : "name username profilePhoto";

  await Message.populate(messages, messagePopulate(userSelect));

  return success(
    res,
    { contactVisible: hasProductContext, messages, total, page, pages: Math.ceil(total / limit) },
    "Conversation loaded",
  );
});

exports.sendMessage = asyncHandler(async (req, res) => {
  let { conversationId, listingId, receiverId, replyTo } = req.body;
  const content = String(req.body.content || "").trim();
  const attachments = (req.fileUploads || []).map((file) => ({
    mimetype: file.mimetype,
    originalname: file.originalname,
    type: attachmentType(file.mimetype),
    url: file.url,
  }));

  if (!content && !attachments.length) {
    throw httpError(422, "Message text or an attachment is required");
  }

  if (conversationId) {
    const latestMessage = await Message.findOne(participantFilter(conversationId, req.user.id)).sort({ createdAt: -1 });

    if (latestMessage) {
      receiverId =
        latestMessage.senderId.toString() === req.user.id
          ? latestMessage.receiverId.toString()
          : latestMessage.senderId.toString();
      conversationId = makeConversationId({ userA: req.user.id, userB: receiverId });
    } else if (parseConversationParticipants(conversationId)?.includes(req.user.id)) {
      const participants = parseConversationParticipants(conversationId);
      receiverId = participants.find((id) => id !== req.user.id);
    } else if (!receiverId) {
      throw httpError(404, "Conversation not found");
    }
  }

  if (!receiverId) throw httpError(422, "A receiver is required");
  if (receiverId.toString() === req.user.id) throw httpError(422, "You cannot message yourself");

  conversationId =
    conversationId ||
    makeConversationId({
      userA: req.user.id,
      userB: receiverId,
    });

  if (replyTo) {
    const repliedMessage = await Message.findOne({
      _id: replyTo,
      ...participantFilter(conversationId, req.user.id),
    });
    if (!repliedMessage) throw httpError(404, "Reply target not found");
  }

  const message = await Message.create({
    conversationId,
    senderId: req.user.id,
    receiverId,
    listingId,
    content,
    replyTo,
    attachments,
    type: content && attachments.length ? "mixed" : messageType(attachments),
  });

  await message.populate(messagePopulate(listingId ? "name username profilePhoto phone" : "name username profilePhoto"));

  await createNotification({
    userId: receiverId,
    type: "chat",
    title: "New message",
    body: content || `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`,
    link: `/inbox?conversationId=${encodeURIComponent(conversationId)}`,
  });

  const realtimePayload = { conversationId, message };
  emitChatEvent(receiverId, "new_message", realtimePayload);
  emitChatEvent(conversationId, "conversation_message", realtimePayload);
  emitChatEvent(req.user.id, "conversation_message", realtimePayload);

  return success(res, { conversationId, message }, "Message sent", 201);
});

exports.markRead = asyncHandler(async (req, res) => {
  await Message.updateMany(
    {
      ...participantFilter(req.params.conversationId, req.user.id),
      receiverId: req.user.id,
    },
    { isRead: true },
  );

  const participants = parseConversationParticipants(req.params.conversationId) || [];
  emitChatEvent(req.user.id, "messages_read", {
    conversationId: req.params.conversationId,
    readBy: req.user.id,
  });
  participants
    .filter((participantId) => participantId !== req.user.id)
    .forEach((participantId) => {
      emitChatEvent(participantId, "messages_read", {
        conversationId: req.params.conversationId,
        readBy: req.user.id,
      });
    });

  return success(res, {}, "Messages marked as read");
});

exports.reactToMessage = asyncHandler(async (req, res) => {
  const allowed = ["thumbs_up", "heart", "thumbs_down", "fire", "sad", "laugh"];
  const reaction = String(req.body.reaction || "");
  if (!allowed.includes(reaction)) throw httpError(422, "Unsupported reaction");

  const message = await Message.findOne({
    _id: req.params.messageId,
    $or: [{ senderId: req.user.id }, { receiverId: req.user.id }],
  });
  if (!message) throw httpError(404, "Message not found");

  const existing = message.reactions.find((item) => item.userId.toString() === req.user.id);
  if (existing) {
    existing.reaction = reaction;
  } else {
    message.reactions.push({ userId: req.user.id, reaction });
  }

  await message.save();
  await message.populate(messagePopulate());

  return success(res, { message }, "Reaction saved");
});

exports.makeConversationId = makeConversationId;
