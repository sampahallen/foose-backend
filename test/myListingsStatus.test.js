const test = require("node:test");
const assert = require("node:assert/strict");
const DigiShop = require("../src/models/DigiShop");
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

test("seller listing status query accepts management collections only", () => {
  const schema = listingRoutes.myListingsQuerySchema;
  assert.equal(schema.safeParse({ status: "active" }).success, true);
  assert.equal(schema.safeParse({ status: "sold" }).success, true);
  assert.equal(schema.safeParse({ status: "draft" }).success, true);
  assert.equal(schema.safeParse({ status: "removed" }).success, false);
  assert.equal(schema.safeParse({ status: "active", extra: "value" }).success, false);
});

test("seller listing endpoint scopes a dedicated draft collection", async () => {
  const originalFindOne = DigiShop.findOne;
  const originalFind = Listing.find;
  let receivedFilter;
  DigiShop.findOne = async () => ({ _id: "shop-1" });
  Listing.find = (filter) => {
    receivedFilter = filter;
    return {
      sort() {
        return { lean: async () => [] };
      },
    };
  };

  try {
    const { payload, statusCode } = await invokeController(listingController.getMyListings, {
      query: { status: "draft" },
      user: { id: "seller-1" },
      validated: { query: { status: "draft" } },
    });
    assert.equal(statusCode, 200);
    assert.deepEqual(receivedFilter, { shopId: "shop-1", status: "draft" });
    assert.deepEqual(payload.data.listings, []);
  } finally {
    DigiShop.findOne = originalFindOne;
    Listing.find = originalFind;
  }
});

test("seller listing endpoint retains the all-nonremoved fallback", async () => {
  const originalFindOne = DigiShop.findOne;
  const originalFind = Listing.find;
  let receivedFilter;
  DigiShop.findOne = async () => ({ _id: "shop-2" });
  Listing.find = (filter) => {
    receivedFilter = filter;
    return {
      sort() {
        return { lean: async () => [] };
      },
    };
  };

  try {
    await invokeController(listingController.getMyListings, {
      query: {},
      user: { id: "seller-2" },
      validated: { query: {} },
    });
    assert.deepEqual(receivedFilter, { shopId: "shop-2", status: { $ne: "removed" } });
  } finally {
    DigiShop.findOne = originalFindOne;
    Listing.find = originalFind;
  }
});

test("draft listing details remain private to the shop owner", async () => {
  const originalFindOne = Listing.findOne;
  const originalUpdateOne = Listing.updateOne;
  Listing.findOne = () => ({
    populate() {
      return {
        lean: async () => ({
          _id: "private-draft-test",
          shopId: { _id: "shop-3", ownerId: "owner-3" },
          status: "draft",
          title: "Unpublished jacket",
        }),
      };
    },
  });
  Listing.updateOne = async () => {
    throw new Error("draft views must not be incremented");
  };

  try {
    await assert.rejects(
      invokeController(listingController.getListing, {
        headers: {},
        params: { id: "private-draft-test" },
      }),
      (error) => error?.status === 404 || error?.statusCode === 404,
    );

    const { payload } = await invokeController(listingController.getListing, {
      headers: {},
      params: { id: "private-draft-test" },
      user: { id: "owner-3" },
    });
    assert.equal(payload.data.listing.title, "Unpublished jacket");
  } finally {
    Listing.findOne = originalFindOne;
    Listing.updateOne = originalUpdateOne;
  }
});
