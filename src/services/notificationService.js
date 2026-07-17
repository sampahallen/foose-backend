const Notification = require("../models/Notification");

const createNotification = async ({ userId, type, title, body, link, eventKey }) => {
  let notification;
  try {
    notification = await Notification.create({
      userId,
      type,
      title,
      body,
      link,
      ...(eventKey ? { eventKey } : {}),
    });
  } catch (error) {
    if (eventKey && error?.code === 11000) {
      return Notification.findOne({ userId, eventKey });
    }
    throw error;
  }

  const { getIO } = require("../config/socket");
  const io = typeof getIO === "function" ? getIO() : null;
  if (io) {
    io.to(userId.toString()).emit("notification", notification);
    io.to(userId.toString()).emit("new-notification", notification);
  }

  return notification;
};

module.exports = {
  createNotification,
};
