const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const { normalizeRoles } = require("../constants/roles");
const User = require("../models/User");
const { verifyAccessToken } = require("../utils/generateToken");
const registerChatSocket = require("../socket/chatSocket");
const { chatUserRoom, notificationUserRoom } = require("../socket/rooms");

let io;

const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Authentication token is required"));
    }

    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.id).select(
      "_id accountStatus isEmailVerified roles role",
    );

    if (!user || (user.accountStatus || "active") !== "active") {
      return next(new Error("User account is not active"));
    }

    socket.user = {
      ...decoded,
      id: user._id.toString(),
      isEmailVerified: Boolean(user.isEmailVerified),
      roles: normalizeRoles(user.roles, user.role),
    };
    delete socket.user.role;
    return next();
  } catch (error) {
    if ([
      "Authentication token is required",
      "User account is not active",
    ].includes(error.message)) {
      return next(error);
    }
    return next(new Error("Invalid socket token"));
  }
};

const registerSocketCapabilities = (io, socket) => {
  socket.join(notificationUserRoom(socket.user.id));

  if (!socket.user.isEmailVerified) return false;

  socket.join(chatUserRoom(socket.user.id));
  registerChatSocket(io, socket);
  return true;
};

const attachRedisAdapter = async (server) => {
  if (!process.env.REDIS_URL) return;

  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();

  pubClient.on("error", (error) => {
    console.error("Socket Redis pub error", error.message);
  });
  subClient.on("error", (error) => {
    console.error("Socket Redis sub error", error.message);
  });

  await Promise.all([pubClient.connect(), subClient.connect()]);
  server.adapter(createAdapter(pubClient, subClient));
  console.log("Socket.io Redis adapter attached");
};

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || "*",
      methods: ["GET", "POST"],
    },
  });

  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    registerSocketCapabilities(io, socket);
  });

  attachRedisAdapter(io).catch((error) => {
    console.error("Socket.io Redis adapter failed", error.message);
  });

  return io;
};

const getIO = () => io;

module.exports = {
  authenticateSocket,
  getIO,
  initSocket,
  registerSocketCapabilities,
};
