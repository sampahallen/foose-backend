const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const { connectRedis } = require("./src/config/redis");
const { initSocket } = require("./src/config/socket");
const { startAccountLifecycleCleanup } = require("./src/utils/accountLifecycle");
const { startFinspoLifecycleCleanup } = require("./src/utils/finspoLifecycle");
const { backfillShadowProfiles } = require("./src/services/recommendationService");
const { backfillMarketplaceLocations } = require("./src/services/locationBackfillService");
const { invalidate, invalidatePattern } = require("./src/utils/cache");

const PORT = process.env.PORT || 5000;

const start = async () => {
  let locationBackfillChanged = false;

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
    try {
      const createdShadowProfiles = await backfillShadowProfiles();
      if (createdShadowProfiles > 0) {
        console.log(`Created ${createdShadowProfiles} missing shadow profile(s)`);
      }
    } catch (error) {
      console.warn(`Shadow profile backfill failed: ${error.message}`);
    }
    try {
      const locationBackfill = await backfillMarketplaceLocations();
      locationBackfillChanged = Boolean(locationBackfill.shopsUpdated || locationBackfill.listingsUpdated);
      console.log(
        `Location backfill: ${locationBackfill.shopsUpdated} shop(s), ${locationBackfill.listingsUpdated} listing(s), ${locationBackfill.unresolvedShops} unresolved shop(s)`,
      );
    } catch (error) {
      console.warn(`Location backfill failed: ${error.message}`);
    }
    startAccountLifecycleCleanup();
    startFinspoLifecycleCleanup();
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    // Don't crash - let the server run
  }

  try {
    await connectRedis();
    console.log("Redis connected");
    if (locationBackfillChanged) {
      await invalidate("listings:featured");
      await invalidatePattern("search:*");
    }
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
