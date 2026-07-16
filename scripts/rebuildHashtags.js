const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { rebuildHashtagCounts } = require("../src/services/hashtagService");

const run = async () => {
  try {
    await connectDB();
    const hashtagCount = await rebuildHashtagCounts();
    console.log(`Rebuilt ${hashtagCount} hashtag record(s)`);
  } finally {
    await mongoose.connection.close();
  }
};

run().catch((error) => {
  console.error(`Hashtag rebuild failed: ${error.message}`);
  process.exitCode = 1;
});
