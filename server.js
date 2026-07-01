const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const { connectRedis } = require("./src/config/redis");
const { initSocket } = require("./src/config/socket");
const { startAccountLifecycleCleanup } = require("./src/utils/accountLifecycle");

const PORT = process.env.PORT || 5000;

const start = async () => {
  // Start the server FIRST so it can respond to health checks
  const app = require("./src/app");
  const httpServer = http.createServer(app);
  initSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Then connect to databases (non-blocking)
  try {
    await connectDB();
    console.log("MongoDB connected");
    startAccountLifecycleCleanup();
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    // Don't crash - let the server run
  }

  try {
    await connectRedis();
    console.log("Redis connected");
  } catch (error) {
    console.error("Redis connection failed:", error.message);
    // Don't crash - let the server run
  }
};

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await mongoose.connection.close();
  process.exit(0);
});
