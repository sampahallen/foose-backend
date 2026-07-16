const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { connectRedis } = require("../src/config/redis");
const { backfillMarketplaceLocations } = require("../src/services/locationBackfillService");
const { invalidate, invalidatePattern } = require("../src/utils/cache");

const run = async () => {
  let redis;

  try {
    await connectDB();
    const result = await backfillMarketplaceLocations();

    redis = await connectRedis();
    if (result.shopsUpdated || result.listingsUpdated) {
      await invalidate("listings:featured");
      await invalidatePattern("search:*");
    }

    console.log(
      `Location backfill complete: ${result.shopsUpdated} shop(s), ${result.listingsUpdated} listing(s), ${result.unresolvedShops} unresolved shop(s)`,
    );
  } finally {
    if (redis?.isOpen) await redis.quit();
    await mongoose.connection.close();
  }
};

run().catch((error) => {
  console.error(`Location backfill failed: ${error.message}`);
  process.exitCode = 1;
});
