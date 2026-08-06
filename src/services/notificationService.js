const Notification = require("../models/Notification");
const User = require("../models/User");
const { chatUserRoom, notificationUserRoom } = require("../socket/rooms");

// KYC notifications are safety-critical and are never gated by preference -
// callers must never pass lifecycleEmailRequired for type "kyc".
const GATED_TYPES = new Set(["order", "chat", "review", "system"]);

// Preferences are stored per user; default to enabled (true) for any account
// that predates the preferences field, or any category with no stored value.
const categoryEmailEnabled = async (userId, category) => {
  const user = await User.findById(userId).select("preferences").lean();
  return user?.preferences?.notifications?.[category]?.email ?? true;
};

const categoryInAppEnabled = async (userId, category) => {
  const user = await User.findById(userId).select("preferences").lean();
  return user?.preferences?.notifications?.[category]?.inApp ?? true;
};

const markCreationResult = (notification, wasCreated) => {
  if (!notification || typeof notification !== "object") return notification;
  if (!notification.$locals) {
    Object.defineProperty(notification, "$locals", {
      configurable: true,
      enumerable: false,
      value: {},
      writable: true,
    });
  }
  notification.$locals.wasCreated = wasCreated;
  return notification;
};

const createNotification = async ({
  userId,
  type,
  title,
  body,
  link,
  eventKey,
  lifecycleEmailRequired = false,
}) => {
  // "system" (follows/likes/comments) is the only category with a full mute:
  // when off, skip creating the record and emitting it entirely.
  if (type === "system" && !(await categoryInAppEnabled(userId, "system"))) {
    return null;
  }

  const emailRequired = lifecycleEmailRequired
    && GATED_TYPES.has(type)
    && (await categoryEmailEnabled(userId, type));

  let notification;
  try {
    notification = await Notification.create({
      userId,
      type,
      title,
      body,
      link,
      ...(eventKey ? { eventKey } : {}),
      ...(emailRequired ? { lifecycleEmailRequired: true } : {}),
    });
  } catch (error) {
    if (eventKey && error?.code === 11000) {
      const existing = await Notification.findOne({ userId, eventKey });
      return markCreationResult(existing, false);
    }
    throw error;
  }
  markCreationResult(notification, true);

  const { getIO } = require("../config/socket");
  const io = typeof getIO === "function" ? getIO() : null;
  if (io) {
    const room = notification.type === "chat"
      ? chatUserRoom(userId)
      : notificationUserRoom(userId);
    io.to(room).emit("notification", notification);
    io.to(room).emit("new-notification", notification);
  }

  return notification;
};

module.exports = {
  categoryEmailEnabled,
  createNotification,
};
