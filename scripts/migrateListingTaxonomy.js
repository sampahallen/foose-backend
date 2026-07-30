const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { connectRedis } = require("../src/config/redis");
const { rebuildHashtagCounts } = require("../src/services/hashtagService");
const { migrateListingTaxonomy } = require("../src/services/listingTaxonomyMigrationService");
const { rebuildSearchIndex } = require("../src/services/searchIndexService");
const { invalidate, invalidatePattern } = require("../src/utils/cache");

const run = async () => {
  let redis;
  try {
    await connectDB();
    const result = await migrateListingTaxonomy();
    const [hashtagCount, searchResult] = await Promise.all([
      rebuildHashtagCounts(),
      rebuildSearchIndex(),
    ]);
    redis = await connectRedis();
    await invalidate("listings:featured");
    await invalidatePattern("search:*");
    console.log(
      `Listing taxonomy migration complete: ${result.updated}/${result.matched} listing(s) updated, ${hashtagCount} hashtag(s), search generation ${searchResult.generation}`,
    );
  } finally {
    if (redis?.isOpen) await redis.quit();
    await mongoose.connection.close();
  }
};

run().catch((error) => {
  console.error(`Listing taxonomy migration failed: ${error.message}`);
  process.exitCode = 1;
});
