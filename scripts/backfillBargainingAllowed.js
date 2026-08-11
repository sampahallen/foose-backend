const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const Listing = require("../src/models/Listing");

// Bargaining is opt-in: listings posted before the feature existed default to
// "not accepting offers" until their seller edits them. Idempotent - reruns
// only touch documents that still have no value.
const run = async () => {
  const dryRun = process.argv.includes("--dry-run");

  try {
    await connectDB();
    const filter = { bargainingAllowed: { $exists: false } };
    const pending = await Listing.countDocuments(filter);

    if (dryRun) {
      console.log(`Bargaining backfill (dry run): ${pending} listing(s) would be set to false`);
      return;
    }

    const result = await Listing.updateMany(filter, { $set: { bargainingAllowed: false } });
    console.log(
      `Bargaining backfill complete: ${result.modifiedCount} of ${pending} listing(s) updated`,
    );
  } finally {
    await mongoose.connection.close();
  }
};

run().catch((error) => {
  console.error(`Bargaining backfill failed: ${error.message}`);
  process.exitCode = 1;
});
