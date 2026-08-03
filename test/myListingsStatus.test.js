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

function mockListingFind({ receivedCalls, results = [] }) {
  return (filter) => {
    receivedCalls.filter = filter;
    return {
      sort(sort) {
        receivedCalls.sort = sort;
        return {
          skip(skip) {
            receivedCalls.skip = skip;
            return {
              limit(limit) {
                receivedCalls.limit = limit;
                return { lean: async () => results };
              },
            };
          },
        };
      },
    };
  };
}

test("seller listing status query accepts management collections and pagination/filter params", () => {
  const schema = listingRoutes.myListingsQuerySchema;
  assert.equal(schema.safeParse({ status: "active" }).success, true);
  assert.equal(schema.safeParse({ status: "sold" }).success, true);
  assert.equal(schema.safeParse({ status: "draft" }).success, true);
  assert.equal(schema.safeParse({ status: "removed" }).success, false);
  assert.equal(schema.safeParse({ status: "active", extra: "value" }).success, false);

  assert.equal(schema.safeParse({ page: "2", limit: "20" }).success, true);
  assert.equal(schema.safeParse({ search: "denim jacket" }).success, true);
  assert.equal(schema.safeParse({ type: "wholesale" }).success, true);
  assert.equal(schema.safeParse({ type: "invalid" }).success, false);
  assert.equal(schema.safeParse({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }).success, true);
  assert.equal(schema.safeParse({ limit: "0" }).success, false);
  assert.equal(schema.safeParse({ limit: "500" }).success, false);
});

test("seller listing endpoint scopes a dedicated draft collection", async () => {
  const originalFindOne = DigiShop.findOne;
  const originalFind = Listing.find;
  const originalCount = Listing.countDocuments;
  const receivedCalls = {};
  DigiShop.findOne = async () => ({ _id: "shop-1" });
  Listing.find = mockListingFind({ receivedCalls });
  Listing.countDocuments = async () => 0;

  try {
    const { payload, statusCode } = await invokeController(listingController.getMyListings, {
      query: { status: "draft" },
      user: { id: "seller-1" },
      validated: { query: { status: "draft" } },
    });
    assert.equal(statusCode, 200);
    assert.deepEqual(receivedCalls.filter, { shopId: "shop-1", status: "draft" });
    assert.deepEqual(payload.data.listings, []);
    assert.equal(payload.data.total, 0);
    assert.equal(payload.data.page, 1);
    assert.equal(payload.data.pages, 1);
  } finally {
    DigiShop.findOne = originalFindOne;
    Listing.find = originalFind;
    Listing.countDocuments = originalCount;
  }
});

test("seller listing endpoint retains the all-nonremoved fallback", async () => {
  const originalFindOne = DigiShop.findOne;
  const originalFind = Listing.find;
  const originalCount = Listing.countDocuments;
  const receivedCalls = {};
  DigiShop.findOne = async () => ({ _id: "shop-2" });
  Listing.find = mockListingFind({ receivedCalls });
  Listing.countDocuments = async () => 0;

  try {
    await invokeController(listingController.getMyListings, {
      query: {},
      user: { id: "seller-2" },
      validated: { query: {} },
    });
    assert.deepEqual(receivedCalls.filter, { shopId: "shop-2", status: { $ne: "removed" } });
  } finally {
    DigiShop.findOne = originalFindOne;
    Listing.find = originalFind;
    Listing.countDocuments = originalCount;
  }
});

test("seller listing endpoint paginates with page/limit and reports totals", async () => {
  const originalFindOne = DigiShop.findOne;
  const originalFind = Listing.find;
  const originalCount = Listing.countDocuments;
  const receivedCalls = {};
  DigiShop.findOne = async () => ({ _id: "shop-3" });
  Listing.find = mockListingFind({ receivedCalls, results: [{ _id: "listing-1" }] });
  Listing.countDocuments = async () => 45;

  try {
    const { payload } = await invokeController(listingController.getMyListings, {
      query: { limit: "20", page: "2", status: "active" },
      user: { id: "seller-3" },
      validated: { query: { limit: 20, page: 2, status: "active" } },
    });
    assert.equal(receivedCalls.skip, 20);
    assert.equal(receivedCalls.limit, 20);
    assert.deepEqual(receivedCalls.sort, { createdAt: -1 });
    assert.equal(payload.data.page, 2);
    assert.equal(payload.data.total, 45);
    assert.equal(payload.data.pages, 3);
  } finally {
    DigiShop.findOne = originalFindOne;
    Listing.find = originalFind;
    Listing.countDocuments = originalCount;
  }
});

test("seller listing endpoint applies a type filter", async () => {
  const originalFindOne = DigiShop.findOne;
  const originalFind = Listing.find;
  const originalCount = Listing.countDocuments;
  const receivedCalls = {};
  DigiShop.findOne = async () => ({ _id: "shop-4" });
  Listing.find = mockListingFind({ receivedCalls });
  Listing.countDocuments = async () => 0;

  try {
    await invokeController(listingController.getMyListings, {
      query: { status: "active", type: "wholesale" },
      user: { id: "seller-4" },
      validated: { query: { status: "active", type: "wholesale" } },
    });
    assert.deepEqual(receivedCalls.filter, { shopId: "shop-4", status: "active", type: "wholesale" });
  } finally {
    DigiShop.findOne = originalFindOne;
    Listing.find = originalFind;
    Listing.countDocuments = originalCount;
  }
});

test("seller listing endpoint builds an escaped case-insensitive search across known fields", async () => {
  const originalFindOne = DigiShop.findOne;
  const originalFind = Listing.find;
  const originalCount = Listing.countDocuments;
  const receivedCalls = {};
  DigiShop.findOne = async () => ({ _id: "shop-5" });
  Listing.find = mockListingFind({ receivedCalls });
  Listing.countDocuments = async () => 0;

  try {
    await invokeController(listingController.getMyListings, {
      query: { status: "active", search: "denim (relaxed)" },
      user: { id: "seller-5" },
      validated: { query: { status: "active", search: "denim (relaxed)" } },
    });
    assert.equal(receivedCalls.filter.shopId, "shop-5");
    assert.equal(receivedCalls.filter.status, "active");
    const orFields = receivedCalls.filter.$or.map((clause) => Object.keys(clause)[0]);
    assert.deepEqual(orFields, ["title", "brand", "category", "subcategory", "size", "gender", "color"]);
    const titlePattern = receivedCalls.filter.$or[0].title;
    assert.ok(titlePattern instanceof RegExp);
    assert.equal(titlePattern.source, "denim \\(relaxed\\)");
    assert.equal(titlePattern.flags, "i");
  } finally {
    DigiShop.findOne = originalFindOne;
    Listing.find = originalFind;
    Listing.countDocuments = originalCount;
  }
});

test("seller listing endpoint applies a createdAt date range", async () => {
  const originalFindOne = DigiShop.findOne;
  const originalFind = Listing.find;
  const originalCount = Listing.countDocuments;
  const receivedCalls = {};
  DigiShop.findOne = async () => ({ _id: "shop-6" });
  Listing.find = mockListingFind({ receivedCalls });
  Listing.countDocuments = async () => 0;

  try {
    await invokeController(listingController.getMyListings, {
      query: { status: "active", dateFrom: "2026-01-01", dateTo: "2026-01-31" },
      user: { id: "seller-6" },
      validated: { query: { status: "active", dateFrom: "2026-01-01", dateTo: "2026-01-31" } },
    });
    assert.deepEqual(receivedCalls.filter, {
      shopId: "shop-6",
      status: "active",
      createdAt: {
        $gte: new Date("2026-01-01T00:00:00.000Z"),
        $lte: new Date("2026-01-31T23:59:59.999Z"),
      },
    });
  } finally {
    DigiShop.findOne = originalFindOne;
    Listing.find = originalFind;
    Listing.countDocuments = originalCount;
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
