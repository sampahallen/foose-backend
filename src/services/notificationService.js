const Notification = require("../models/Notification");

const createNotification = async ({ userId, type, title, body, link }) => {
  const notification = await Notification.create({
    userId,
    type,
    title,
    body,
    link,
  });

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
