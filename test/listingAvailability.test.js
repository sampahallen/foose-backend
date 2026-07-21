const test = require("node:test");
const assert = require("node:assert/strict");
const Listing = require("../src/models/Listing");
const listingController = require("../src/controllers/listingController");
const listingRoutes = require("../src/routes/listingRoutes");

const invokeController = (controller, req) => new Promise((resolve, reject) => {
  let statusCode = 200;
  const res = {
    status(nextStatusCode) {
      statusCode = nextStatusCode;
      return this;
    },
    json(payload) {
      resolve({ payload, statusCode });
      return payload;
    },
  };
  controller(req, res, (error) => reject(error || new Error("Controller called next without a response")));
});

test("cart availability query accepts at most 50 valid listing IDs", () => {
  const schema = listingRoutes.availabilityQuerySchema;
  const validIds = ["64b000000000000000000001", "64b000000000000000000002"];
  assert.deepEqual(schema.parse({ ids: validIds.join(",") }).ids, validIds);
  assert.equal(schema.safeParse({ ids: "not-an-id" }).success, false);
  assert.equal(schema.safeParse({ ids: Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(24, "0")).join(",") }).success, false);
});

test("cart availability distinguishes sold listings and treats private or missing listings as removed", async () => {
  const activeId = "64b000000000000000000001";
  const soldId = "64b000000000000000000002";
  const removedId = "64b000000000000000000003";
  const missingId = "64b000000000000000000004";
  const originalFind = Listing.find;

  Listing.find = () => ({
    select() {
      return {
        lean: async () => [
          { _id: activeId, status: "active" },
          { _id: soldId, status: "sold" },
          { _id: removedId, status: "removed" },
        ],
      };
    },
  });

  try {
    const { payload, statusCode } = await invokeController(listingController.getListingAvailability, {
      validated: { query: { ids: [activeId, soldId, removedId, missingId] } },
    });

    assert.equal(statusCode, 200);
    assert.deepEqual(payload.data.statuses, {
      [activeId]: "active",
      [soldId]: "sold",
      [removedId]: "removed",
      [missingId]: "removed",
    });
  } finally {
    Listing.find = originalFind;
  }
});
