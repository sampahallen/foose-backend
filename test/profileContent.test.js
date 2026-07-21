const test = require("node:test");
const assert = require("node:assert/strict");
const DigiShop = require("../src/models/DigiShop");
const Event = require("../src/models/Event");
const GalleryPost = require("../src/models/GalleryPost");
const Listing = require("../src/models/Listing");
const User = require("../src/models/User");
const userController = require("../src/controllers/userController");
const userRoutes = require("../src/routes/userRoutes");

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

const query = (value, capture = {}) => ({
  lean: async () => value,
  limit(limit) {
    capture.limit = limit;
    return this;
  },
  populate(path, select) {
    capture.populate = { path, select };
    return this;
  },
  select(value) {
    capture.select = value;
    return this;
  },
  skip(skip) {
    capture.skip = skip;
    return this;
  },
  sort(sort) {
    capture.sort = sort;
    return this;
  },
});

test("profile content query accepts only supported, bounded pagination", () => {
  const schema = userRoutes.profileContentQuerySchema;
  assert.deepEqual(schema.parse({ type: "finspo" }), { type: "finspo", page: 1, limit: 12 });
  assert.deepEqual(schema.parse({ type: "events", page: "2", limit: "24" }), { type: "events", page: 2, limit: 24 });
  assert.equal(schema.safeParse({ type: "orders" }).success, false);
  assert.equal(schema.safeParse({ type: "listings", page: 0 }).success, false);
  assert.equal(schema.safeParse({ type: "finspo", limit: 25 }).success, false);
  assert.equal(schema.safeParse({ type: "events", extra: true }).success, false);
});

test("profile summary returns counts and the viewer follow state without private embedded content", async () => {
  const originals = {
    eventCount: Event.countDocuments,
    finspoCount: GalleryPost.countDocuments,
    listingCount: Listing.countDocuments,
    shopFindOne: DigiShop.findOne,
    userCount: User.countDocuments,
    userExists: User.exists,
    userFindOne: User.findOne,
  };
  const user = { _id: "user-1", following: ["followed-1"], name: "Ama", username: "ama" };
  const shop = { _id: "shop-1", shopName: "Ama Shop", slug: "ama-shop" };
  User.findOne = () => query(user);
  DigiShop.findOne = () => query(shop);
  GalleryPost.countDocuments = async () => 7;
  Listing.countDocuments = async () => 4;
  Event.countDocuments = async () => 3;
  User.countDocuments = async () => 9;
  User.exists = async (filter) => filter._id === "viewer-1" && filter.following === "user-1" ? { _id: "viewer-1" } : null;

  try {
    const { payload } = await invokeController(userController.getProfileByUsername, { params: { username: "AMA" }, user: { id: "viewer-1" } });
    assert.deepEqual(payload.data.contentCounts, { events: 3, finspo: 7, listings: 4 });
    assert.equal(payload.data.followerCount, 9);
    assert.equal(payload.data.followingCount, 9);
    assert.equal(payload.data.isFollowing, true);
    assert.equal(payload.data.shop, shop);
    for (const removed of ["activeOrders", "events", "gallery", "listings"]) {
      assert.equal(Object.hasOwn(payload.data, removed), false);
    }
  } finally {
    Event.countDocuments = originals.eventCount;
    GalleryPost.countDocuments = originals.finspoCount;
    Listing.countDocuments = originals.listingCount;
    DigiShop.findOne = originals.shopFindOne;
    User.countDocuments = originals.userCount;
    User.exists = originals.userExists;
    User.findOne = originals.userFindOne;
  }
});

test("Finspo profile pages exclude archived posts and apply pagination", async () => {
  const originalFindOne = User.findOne;
  const originalFind = GalleryPost.find;
  const originalCount = GalleryPost.countDocuments;
  const capture = {};
  let receivedFilter;
  User.findOne = () => query({ _id: "user-2" });
  GalleryPost.find = (filter) => {
    receivedFilter = filter;
    return query([{ _id: "finspo-13", imageUrl: "look.jpg" }], capture);
  };
  GalleryPost.countDocuments = async () => 13;

  try {
    const { payload } = await invokeController(userController.getProfileContent, {
      params: { username: "creator" },
      query: {},
      validated: { params: { username: "creator" }, query: { type: "finspo", page: 2, limit: 12 } },
    });
    assert.deepEqual(receivedFilter, { isArchived: { $ne: true }, userId: "user-2" });
    assert.equal(capture.skip, 12);
    assert.equal(capture.limit, 12);
    assert.deepEqual(payload.data, {
      items: [{ _id: "finspo-13", imageUrl: "look.jpg" }],
      page: 2,
      pages: 2,
      total: 13,
      type: "finspo",
    });
  } finally {
    User.findOne = originalFindOne;
    GalleryPost.find = originalFind;
    GalleryPost.countDocuments = originalCount;
  }
});

test("listing profile pages expose only active marketplace inventory", async () => {
  const originals = {
    shopFindOne: DigiShop.findOne,
    listingCount: Listing.countDocuments,
    listingFind: Listing.find,
    userFindOne: User.findOne,
  };
  let receivedFilter;
  User.findOne = () => query({ _id: "seller-1" });
  DigiShop.findOne = () => query({ _id: "shop-2" });
  Listing.find = (filter) => {
    receivedFilter = filter;
    return query([{ _id: "listing-1", status: "active" }]);
  };
  Listing.countDocuments = async () => 1;

  try {
    const { payload } = await invokeController(userController.getProfileContent, {
      params: { username: "seller" },
      query: {},
      validated: { params: { username: "seller" }, query: { type: "listings", page: 1, limit: 12 } },
    });
    assert.deepEqual(receivedFilter, { shopId: "shop-2", status: "active", visibility: { $ne: "event" } });
    assert.equal(payload.data.total, 1);
  } finally {
    DigiShop.findOne = originals.shopFindOne;
    Listing.countDocuments = originals.listingCount;
    Listing.find = originals.listingFind;
    User.findOne = originals.userFindOne;
  }
});

test("event profile pages include past and upcoming posts with computed status", async () => {
  const originalFindOne = User.findOne;
  const originalFind = Event.find;
  const originalCount = Event.countDocuments;
  User.findOne = () => query({ _id: "host-1" });
  Event.find = () => query([
    { _id: "past", date: "2020-01-01T00:00:00.000Z" },
    { _id: "future", date: "2999-01-01T00:00:00.000Z" },
  ]);
  Event.countDocuments = async () => 2;

  try {
    const { payload } = await invokeController(userController.getProfileContent, {
      params: { username: "host" },
      query: {},
      validated: { params: { username: "host" }, query: { type: "events", page: 1, limit: 12 } },
    });
    assert.deepEqual(payload.data.items.map((event) => event.status), ["past", "upcoming"]);
  } finally {
    User.findOne = originalFindOne;
    Event.find = originalFind;
    Event.countDocuments = originalCount;
  }
});

test("profile content route is registered before the profile summary route", () => {
  const paths = userRoutes.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.ok(paths.indexOf("/:username/profile/content") < paths.indexOf("/:username/profile"));
});
