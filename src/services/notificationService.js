const Notification = require("../models/Notification");
const { chatUserRoom, notificationUserRoom } = require("../socket/rooms");

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
  let notification;
  try {
    notification = await Notification.create({
      userId,
      type,
      title,
      body,
      link,
      ...(eventKey ? { eventKey } : {}),
      ...(lifecycleEmailRequired ? { lifecycleEmailRequired: true } : {}),
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
  createNotification,
};
