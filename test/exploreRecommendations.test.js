const test = require("node:test");
const assert = require("node:assert/strict");
const { EXPLORE_FEED } = require("../src/constants/recommendations");
const optionalAuth = require("../src/middleware/optionalAuthMiddleware");
const recommendationRoutes = require("../src/routes/recommendationRoutes");
const DigiShop = require("../src/models/DigiShop");
const Event = require("../src/models/Event");
const GalleryPost = require("../src/models/GalleryPost");
const Listing = require("../src/models/Listing");
const ShadowProfile = require("../src/models/ShadowProfile");
const User = require("../src/models/User");
const {
  buildExploreFeed,
  isOwnExploreEntity,
  profileSignalCount,
  resolveExploreSession,
  scoreEvent,
  scoreExploreUser,
} = require("../src/services/exploreRecommendationService");
const {
  composeExploreFeed,
  decodeExploreCursor,
  encodeExploreCursor,
  quotasForSize,
  selectExploreBatch,
  selectExplorePersonalizedKeys,
} = require("../src/utils/exploreFeed");

const candidates = (type, count, score = 0) => Array.from({ length: count }, (_, index) => ({
  id: `${type}-${index}`,
  score: typeof score === "function" ? score(index) : score,
  type,
}));

test("Explore exposes an optional-auth route with a 50-result contract", () => {
  const layer = recommendationRoutes.stack.find(
    (entry) => entry.route?.path === "/explore" && entry.route.methods.get,
  );
  assert.ok(layer);
  assert.equal(layer.route.stack[0].handle, optionalAuth);
  assert.equal(EXPLORE_FEED.PAGE_SIZE, 50);
  assert.equal(EXPLORE_FEED.MAX_PERSONALIZED, 25);
  assert.equal(EXPLORE_FEED.SIGNAL_THRESHOLD, 5);
  assert.deepEqual(EXPLORE_FEED.QUOTAS, { item: 20, finspo: 20, event: 5, user: 5 });
});

test("Explore cursors are signed and retain their seed, snapshot, and offset", () => {
  const snapshot = "2030-06-02T12:00:00.000Z";
  const personalizedKeys = ["item:item-1", "finspo:post-1"];
  const cursor = encodeExploreCursor({
    audience: "guest",
    offset: 50,
    personalizedKeys,
    seed: "session-seed",
    snapshot,
  });
  const decoded = decodeExploreCursor(cursor);
  assert.equal(decoded.offset, 50);
  assert.deepEqual(decoded.personalizedKeys, personalizedKeys);
  assert.equal(decoded.seed, "session-seed");
  assert.equal(decoded.snapshot.toISOString(), snapshot);
  assert.throws(() => decodeExploreCursor(`${cursor.slice(0, -1)}x`), /cursor is invalid/i);
  assert.throws(
    () => decodeExploreCursor(encodeExploreCursor({
      audience: "guest",
      offset: EXPLORE_FEED.MAX_CURSOR_OFFSET + 1,
      seed: "session-seed",
      snapshot,
    })),
    /cursor is invalid/i,
  );
  assert.throws(
    () => resolveExploreSession({ cursor, userId: "member-1" }),
    /another session/i,
  );
});

test("Explore quotas scale down and equal 20/20/5/5 at the default size", () => {
  assert.deepEqual(quotasForSize(50), { item: 20, finspo: 20, event: 5, user: 5 });
  assert.deepEqual(quotasForSize(10), { item: 4, finspo: 4, event: 1, user: 1 });
});

test("Explore selects at most 25 positive personalized matches and fills discovery quotas", () => {
  const pool = [
    ...candidates("item", 40, 20),
    ...candidates("finspo", 40, (index) => index < 10 ? 10 : 0),
    ...candidates("event", 10, 0),
    ...candidates("user", 10, 0),
  ];
  const selected = selectExploreBatch({
    candidates: pool,
    personalized: true,
    seed: "personalized-explore",
    size: 50,
  });

  assert.equal(selected.results.length, 50);
  assert.equal(selected.personalizedCount, 25);
  assert.equal(selected.discoveryCount, 25);
  assert.deepEqual(selected.allocations, { item: 20, finspo: 20, event: 5, user: 5 });
  assert.ok(selected.results.filter((entry) => entry.personalized).every((entry) => entry.score > 0));
  assert.equal(selectExplorePersonalizedKeys({ candidates: pool, seed: "personalized-explore" }).length, 25);
});

test("Explore fills shortages without duplicates and keeps type runs to two while alternatives remain", () => {
  const full = composeExploreFeed({
    candidates: [
      ...candidates("item", 30),
      ...candidates("finspo", 30),
      ...candidates("event", 10),
      ...candidates("user", 10),
    ],
    personalized: false,
    seed: "diverse-explore",
  });
  assert.equal(new Set(full.results.map((entry) => `${entry.type}:${entry.id}`)).size, 80);
  for (let index = 2; index < full.results.length; index += 1) {
    assert.equal(
      full.results[index].type === full.results[index - 1].type &&
        full.results[index].type === full.results[index - 2].type,
      false,
    );
  }

  const shortage = selectExploreBatch({
    candidates: [
      ...candidates("item", 60),
      ...candidates("finspo", 2),
      ...candidates("event", 1),
    ],
    personalized: false,
    seed: "shortage-explore",
    size: 50,
  });
  assert.equal(shortage.results.length, 50);
  assert.equal(new Set(shortage.results.map((entry) => `${entry.type}:${entry.id}`)).size, 50);
  assert.equal(shortage.allocations.item, 47);
  assert.equal(shortage.allocations.finspo, 2);
  assert.equal(shortage.allocations.event, 1);
});

test("Explore personalization needs five recorded signals", () => {
  assert.equal(profileSignalCount(null), 0);
  assert.equal(profileSignalCount({ signalCounts: { view: 2, favorite: 2 } }), 4);
  assert.equal(profileSignalCount({ signalCounts: new Map([["view", 3], ["favorite", 2]]) }), 5);
});

test("Explore excludes every kind of the current member's own content", () => {
  const context = { ownShopId: "shop-me", userId: "user-me" };
  assert.equal(isOwnExploreEntity({ ...context, type: "item", entity: { shopId: { _id: "shop-me" } } }), true);
  assert.equal(isOwnExploreEntity({ ...context, type: "finspo", entity: { userId: { _id: "user-me" } } }), true);
  assert.equal(isOwnExploreEntity({ ...context, type: "event", entity: { organizerId: "user-me" } }), true);
  assert.equal(isOwnExploreEntity({ ...context, type: "user", entity: { _id: "user-me" } }), true);
  assert.equal(isOwnExploreEntity({ ...context, type: "item", entity: { shopId: "shop-other" } }), false);
});

test("event and user scoring use profile location, shop, type, and creator matches", () => {
  const profile = {
    itemAffinities: {
      category: { fair: 3 },
      digishopId: { "shop-1": 4 },
      hashtags: { streetwear: 2, summer: 1 },
      location: {
        accra: 5,
        "accra,_greater_accra": 7,
        ashanti: 3,
        kumasi: 2,
        "kumasi,_ashanti": 7,
      },
    },
    finspoAffinities: {
      creatorId: { "creator-1": 6, "user-1": 8 },
      hashtags: { streetwear: 4, summer: 3 },
    },
  };
  assert.equal(scoreEvent(profile, {
    location: "Accra",
    organizerId: { _id: "creator-1" },
    promotionTags: ["#Streetwear", "summer"],
    shopId: { _id: "shop-1", location: { city: "Kumasi", region: "Ashanti" } },
    type: "fair",
  }), 40);
  assert.equal(scoreExploreUser(profile, {
    _id: "user-1",
    location: { city: "Accra", region: "Greater Accra" },
    shop: { _id: "shop-1" },
  }), 24);
});

test("Explore freezes personalized ranking in the cursor when the profile changes between pages", async () => {
  const users = Array.from({ length: 80 }, (_, index) => ({
    _id: `candidate-${String(index).padStart(2, "0")}`,
    name: `Candidate ${index}`,
    username: `candidate${index}`,
  }));
  const initialCreatorScores = Object.fromEntries(
    users.map((user, index) => [user._id, 100 - index]),
  );
  const changedCreatorScores = Object.fromEntries(
    [...users].reverse().map((user, index) => [user._id, 100 - index]),
  );
  let profile = {
    finspoAffinities: { creatorId: initialCreatorScores },
    signalCounts: { view: 5 },
  };
  const originals = new Map([
    [DigiShop, { find: DigiShop.find, findOne: DigiShop.findOne }],
    [Event, { find: Event.find }],
    [GalleryPost, { find: GalleryPost.find }],
    [Listing, { find: Listing.find }],
    [ShadowProfile, { findOne: ShadowProfile.findOne }],
    [User, { find: User.find }],
  ]);
  const query = (rows) => ({
    lean: async () => rows,
    limit() { return this; },
    select() { return this; },
    sort() { return this; },
  });

  DigiShop.find = () => query([]);
  DigiShop.findOne = () => query(null);
  Event.find = () => query([]);
  GalleryPost.find = () => query([]);
  Listing.find = () => query([]);
  ShadowProfile.findOne = () => query(profile);
  User.find = () => query(users);

  try {
    const first = await buildExploreFeed({
      query: { limit: 10, seed: "frozen-profile" },
      userId: "viewer",
    });
    assert.ok(first.nextCursor);
    assert.equal(decodeExploreCursor(first.nextCursor).personalizedKeys.length, 25);

    const expected = await buildExploreFeed({
      query: { cursor: first.nextCursor, limit: 10 },
      userId: "viewer",
    });
    profile = {
      finspoAffinities: { creatorId: changedCreatorScores },
      signalCounts: { favorite: 20 },
    };
    const afterProfileChange = await buildExploreFeed({
      query: { cursor: first.nextCursor, limit: 10 },
      userId: "viewer",
    });

    assert.deepEqual(
      afterProfileChange.results.map((result) => String(result.entity._id)),
      expected.results.map((result) => String(result.entity._id)),
    );
  } finally {
    originals.forEach((methods, Model) => {
      Object.assign(Model, methods);
    });
  }
});

test("an empty guest Explore response still returns stable feed metadata", async () => {
  const models = [DigiShop, Event, GalleryPost, Listing, User];
  const originals = new Map(models.map((Model) => [Model, Model.find]));
  const emptyQuery = () => ({
    lean: async () => [],
    limit() { return this; },
    select() { return this; },
    sort() { return this; },
  });
  models.forEach((Model) => {
    Model.find = () => emptyQuery();
  });

  try {
    const response = await buildExploreFeed({ query: { seed: "guest-session" } });
    assert.deepEqual(response.results, []);
    assert.equal(response.total, 0);
    assert.equal(response.hasMore, false);
    assert.equal(response.nextCursor, null);
    assert.equal(response.feedSeed, "guest-session");
    assert.equal(response.seed, "guest-session");
    assert.match(response.snapshot, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(response.feed.allocations, { items: 0, finspo: 0, events: 0, users: 0 });
    assert.deepEqual(response.feed.quotas, { items: 20, finspo: 20, events: 5, users: 5 });
    assert.equal(response.feed.signalCount, 0);
    assert.equal(response.feed.signalThreshold, 5);
  } finally {
    originals.forEach((find, Model) => {
      Model.find = find;
    });
  }
});
