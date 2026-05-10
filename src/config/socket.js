const { Server } = require("socket.io");
const { verifyAccessToken } = require("../utils/generateToken");
const registerChatSocket = require("../socket/chatSocket");

let io;

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

  return io;
};

const getIO = () => io;

module.exports = {
  initSocket,
  getIO,
};
