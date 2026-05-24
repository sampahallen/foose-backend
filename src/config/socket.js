const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const { verifyAccessToken } = require("../utils/generateToken");
const registerChatSocket = require("../socket/chatSocket");

let io;

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

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error("Authentication token is required"));
      }

      socket.user = verifyAccessToken(token);
      next();
    } catch {
      next(new Error("Invalid socket token"));
    }
  });

  io.on("connection", (socket) => {
    socket.join(socket.user.id);
    registerChatSocket(io, socket);
  });

  attachRedisAdapter(io).catch((error) => {
    console.error("Socket.io Redis adapter failed", error.message);
  });

  return io;
};

const getIO = () => io;

module.exports = {
  initSocket,
  getIO,
};
