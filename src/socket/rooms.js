const roomFor = (namespace, userId) => {
  const value = userId?._id || userId;
  const normalizedId = String(value || "").trim();
  return normalizedId ? `${namespace}:${normalizedId}` : "";
};

const chatUserRoom = (userId) => roomFor("chat", userId);
const notificationUserRoom = (userId) => roomFor("notifications", userId);

module.exports = {
  chatUserRoom,
  notificationUserRoom,
};
