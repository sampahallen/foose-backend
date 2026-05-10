const Message = require("../models/Message");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");

const makeConversationId = ({ userA, userB, listingId }) => {
  return `${[userA.toString(), userB.toString()].sort().join("_")}_${listingId || "general"}`;
};

exports.listConversation = asyncHandler(async (req, res) => {
  const messages = await Message.find({
    conversationId: req.params.conversationId,
    $or: [{ senderId: req.user.id }, { receiverId: req.user.id }],
  })
    .populate("senderId", "name username profilePhoto")
    .populate("receiverId", "name username profilePhoto")
    .sort({ createdAt: 1 });

  return success(res, { messages }, "Conversation loaded");
});

exports.sendMessage = asyncHandler(async (req, res) => {
  const conversationId =
    req.body.conversationId ||
    makeConversationId({
      userA: req.user.id,
      userB: req.body.receiverId,
      listingId: req.body.listingId,
    });

  const message = await Message.create({
    conversationId,
    senderId: req.user.id,
    receiverId: req.body.receiverId,
    listingId: req.body.listingId,
    content: req.body.content,
    type: req.body.type || "text",
  });

  return success(res, { message }, "Message sent", 201);
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
