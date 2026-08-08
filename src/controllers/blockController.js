const BlockedUser = require("../models/BlockedUser");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");

exports.listBlocked = asyncHandler(async (req, res) => {
  const blocks = await BlockedUser.find({ userId: req.user.id })
    .populate("blockedUserId", "name username profilePhoto")
    .sort({ createdAt: -1 })
    .lean();

  return success(res, { blocks }, "Blocked accounts loaded");
});

exports.blockStatus = asyncHandler(async (req, res) => {
  const block = await BlockedUser.findOne({
    userId: req.user.id,
    blockedUserId: req.params.userId,
  }).select("_id");

  return success(res, { active: Boolean(block) }, "Block status loaded");
});

exports.blockUser = asyncHandler(async (req, res) => {
  if (req.params.userId === req.user.id) {
    throw httpError(400, "You cannot block yourself");
  }

  const target = await User.findById(req.params.userId).select("_id");
  if (!target) throw httpError(404, "User not found");

  await BlockedUser.updateOne(
    { userId: req.user.id, blockedUserId: req.params.userId },
    { $setOnInsert: { userId: req.user.id, blockedUserId: req.params.userId } },
    { setDefaultsOnInsert: true, upsert: true },
  );

  return success(res, { active: true }, "User blocked");
});

exports.unblockUser = asyncHandler(async (req, res) => {
  await BlockedUser.findOneAndDelete({
    userId: req.user.id,
    blockedUserId: req.params.userId,
  });

  return success(res, { active: false }, "User unblocked");
});
