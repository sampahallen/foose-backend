const Notification = require("../models/Notification");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");

exports.listNotifications = asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const filter = { userId: req.user.id };

  if (req.query.isRead !== undefined) {
    filter.isRead = req.query.isRead === "true";
  }

  const [notifications, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Notification.countDocuments(filter),
  ]);

  return success(res, {
    notifications,
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

exports.markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { isRead: true },
    { new: true },
  );

  if (!notification) throw httpError(404, "Notification not found");

  return success(res, { notification }, "Notification marked as read");
});

exports.markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ userId: req.user.id }, { isRead: true });
  return success(res, {}, "All notifications marked as read");
});
