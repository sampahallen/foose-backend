const mongoose = require("mongoose");
const Message = require("../models/Message");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");
const httpError = require("../utils/httpError");
const { createNotification } = require("../services/notificationService");

const makeConversationId = ({ userA, userB, listingId }) => {
  return `${[userA.toString(), userB.toString()].sort().join("_")}_${listingId || "general"}`;
};

const idValue = (value) => {
  if (!value) return "";
  if (value._id) return value._id.toString();
  return value.toString();
};

const attachmentType = (mimetype = "") => (mimetype.startsWith("video/") ? "video" : "image");

const messageType = (attachments) => {
  const types = new Set(attachments.map((attachment) => attachment.type));
  if (types.size > 1) return "mixed";
  return types.values().next().value || "text";
};

exports.listConversations = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 40), 1), 100);
  const userObjectId = new mongoose.Types.ObjectId(req.user.id);
  const rows = await Message.aggregate([
    {
      $match: {
        $or: [{ senderId: userObjectId }, { receiverId: userObjectId }],
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$conversationId",
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
    { $limit: limit },
  ]);

  const latestMessages = await Message.populate(
    rows.map((row) => row.latestMessage),
    [
      { path: "senderId", select: "name username profilePhoto" },
      { path: "receiverId", select: "name username profilePhoto" },
      { path: "listingId", select: "title images price currency" },
    ],
  );

  const conversations = rows.map((row, index) => {
    const latestMessage = latestMessages[index];
    const senderId = idValue(latestMessage.senderId);
    const participant =
      senderId === req.user.id ? latestMessage.receiverId : latestMessage.senderId;

    return {
      conversationId: row._id,
      latestMessage,
      unreadCount: row.unreadCount,
      participant,
      listing: latestMessage.listingId,
    };
  });

  return success(res, { conversations }, "Conversations loaded");
});

exports.listConversation = asyncHandler(async (req, res) => {
  const messages = await Message.find({
    conversationId: req.params.conversationId,
    $or: [{ senderId: req.user.id }, { receiverId: req.user.id }],
  })
    .sort({ createdAt: 1 });

  const hasProductContext = messages.some((message) => Boolean(message.listingId));
  const userSelect = hasProductContext
    ? "name username profilePhoto phone"
    : "name username profilePhoto";

  await Message.populate(messages, [
    { path: "senderId", select: userSelect },
    { path: "receiverId", select: userSelect },
    { path: "listingId", select: "title images price currency" },
  ]);

  return success(
    res,
    { contactVisible: hasProductContext, messages },
    "Conversation loaded",
  );
});

exports.sendMessage = asyncHandler(async (req, res) => {
  let { conversationId, listingId, receiverId } = req.body;
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
    const latestMessage = await Message.findOne({
      conversationId,
      $or: [{ senderId: req.user.id }, { receiverId: req.user.id }],
    }).sort({ createdAt: -1 });

    if (latestMessage) {
      receiverId =
        latestMessage.senderId.toString() === req.user.id
          ? latestMessage.receiverId.toString()
          : latestMessage.senderId.toString();
      listingId = listingId || latestMessage.listingId;
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
      listingId,
    });

  const message = await Message.create({
    conversationId,
    senderId: req.user.id,
    receiverId,
    listingId,
    content,
    attachments,
    type: content && attachments.length ? "mixed" : messageType(attachments),
  });

  await message.populate([
    { path: "senderId", select: listingId ? "name username profilePhoto phone" : "name username profilePhoto" },
    { path: "receiverId", select: listingId ? "name username profilePhoto phone" : "name username profilePhoto" },
    { path: "listingId", select: "title images price currency" },
  ]);

  await createNotification({
    userId: receiverId,
    type: "chat",
    title: "New message",
    body: content || `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`,
    link: `/inbox?conversationId=${encodeURIComponent(conversationId)}`,
  });

  return success(res, { conversationId, message }, "Message sent", 201);
});

exports.markRead = asyncHandler(async (req, res) => {
  await Message.updateMany(
    {
      conversationId: req.params.conversationId,
      receiverId: req.user.id,
    },
    { isRead: true },
  );

  return success(res, {}, "Messages marked as read");
});

exports.makeConversationId = makeConversationId;
