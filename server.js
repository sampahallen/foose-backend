require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const app = require("./src/app");
const connectDB = require("./src/config/db");
const { connectRedis } = require("./src/config/redis");
const { initSocket } = require("./src/config/socket");

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();
  await connectRedis();

  const httpServer = http.createServer(app);
  initSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await mongoose.connection.close();
  process.exit(0);
});
