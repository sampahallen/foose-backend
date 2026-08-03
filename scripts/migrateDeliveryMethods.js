const path = require("path");

const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const Order = require("../src/models/Order");
const { STATION_PICKUP_COMPANIES } = require("../src/constants/delivery");

const dryRun = process.argv.includes("--dry-run");

const legacyMethodFilter = { "delivery.method": { $in: ["pickup", "delivery"] } };

const companyFromLegacyServiceName = (serviceName) => {
  const trimmed = String(serviceName || "").trim().toLowerCase();
  if (!trimmed) return "";
  return (
    STATION_PICKUP_COMPANIES.find(
      (company) => company.toLowerCase() === trimmed,
    ) || ""
  );
};

const migrateDeliveryMethods = async (counters = { pickup: 0, delivery: 0 }) => {
  const cursor = Order.collection.find(legacyMethodFilter, {
    projection: { delivery: 1 },
  });

  for await (const order of cursor) {
    const legacyMethod = order.delivery?.method;
    if (legacyMethod === "pickup") {
      counters.pickup += 1;
      if (!dryRun) {
        await Order.collection.updateOne(
          { _id: order._id, "delivery.method": "pickup" },
          { $set: { "delivery.method": "shop_pickup" } },
        );
      }
    } else if (legacyMethod === "delivery") {
      counters.delivery += 1;
      const company = companyFromLegacyServiceName(
        order.delivery?.transit?.serviceName,
      );
      if (!dryRun) {
        await Order.collection.updateOne(
          { _id: order._id, "delivery.method": "delivery" },
          {
            $set: {
              "delivery.method": "station_pickup",
              ...(company ? { "delivery.company": company } : {}),
            },
          },
        );
      }
    }
  }

  return counters;
};

const run = async () => {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

  try {
    await connectDB();
    const counters = await migrateDeliveryMethods();
    const prefix = dryRun ? "Delivery method migration dry run" : "Delivery method migration";
    console.log(
      `${prefix} complete: ${counters.pickup} "pickup" -> "shop_pickup", ${counters.delivery} "delivery" -> "station_pickup"`,
    );
  } finally {
    await mongoose.connection.close();
  }
};

if (require.main === module) {
  run().catch((error) => {
    console.error(`Delivery method migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  companyFromLegacyServiceName,
  migrateDeliveryMethods,
};
