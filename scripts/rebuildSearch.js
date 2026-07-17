const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { rebuildSearchIndex } = require("../src/services/searchIndexService");

const run = async () => {
  try {
    await connectDB();
    const result = await rebuildSearchIndex();
    Object.entries(result.counts).forEach(([source, counts]) => {
      console.log(`${source}: indexed ${counts.indexed} of ${counts.source}`);
    });
    console.log(`Search generation ${result.generation}; pruned ${result.pruned} stale document(s)`);
  } finally {
    await mongoose.connection.close();
  }
};

run().catch((error) => {
  console.error(`Search rebuild failed: ${error.message}`);
  process.exitCode = 1;
});
