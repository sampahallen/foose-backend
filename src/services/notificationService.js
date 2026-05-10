const Notification = require("../models/Notification");
const { getIO } = require("../config/socket");

const createNotification = async ({ userId, type, title, body, link }) => {
  const notification = await Notification.create({
    userId,
    type,
    title,
    body,
    link,
  });

  const io = getIO();
  if (io) {
    io.to(userId.toString()).emit("notification", notification);
  }

  return notification;
};

module.exports = {
  createNotification,
};
