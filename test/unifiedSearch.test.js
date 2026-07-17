const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const SearchDocument = require("../src/models/SearchDocument");
const {
  autocompleteTokensFor,
  eventExpiresAt,
  isActiveEvent,
  mapEventSearchDocument,
  mapFinspoSearchDocument,
  mapListingSearchDocument,
  mapUserSearchDocument,
  normalizeSearchText,
} = require("../src/services/searchIndexService");
const {
  afterSortMatch,
  decodeCursor,
  diversifyRows,
  encodeCursor,
  shouldLogUnifiedSearch,
  sortPosition,
  textSearchExpression,
  visiblePrefixLength,
} = require("../src/services/searchQueryService");

test("search documents expose only materialized public search metadata", () => {
  const paths = Object.keys(SearchDocument.schema.paths);
  ["email", "phone", "wallet", "passwordHash", "orders", "messages", "kycId"].forEach((field) => {
    assert.equal(paths.includes(field), false);
  });
  ["sourceType", "sourceId", "primaryText", "hashtags", "autocompleteTokens"].forEach((field) => {
    assert.equal(paths.includes(field), true);
  });

  const indexes = SearchDocument.schema.indexes();
  const names = indexes.map(([, options]) => options.name);
  assert.ok(names.includes("search_source_unique"));
  assert.ok(names.includes("search_weighted_text"));
  assert.ok(names.includes("search_autocomplete_prefix"));
  assert.ok(names.includes("search_hashtag_type_date"));
  assert.equal(indexes.find(([, options]) => options.name === "search_source_unique")[1].unique, true);
});

test("autocomplete materialization normalizes text and stores deterministic prefixes", () => {
  assert.equal(normalizeSearchText("  Café   STREET  "), "café street");
  assert.deepEqual(
    autocompleteTokensFor(["Blue Dress", "blue"]),
    ["bl", "blu", "blue", "blue ", "blue d", "blue dr", "blue dre", "blue dres", "blue dress", "dr", "dre", "dres", "dress"],
  );
});

test("event visibility uses the explicit end or the end of its calendar day", () => {
  const event = { date: new Date("2030-06-02T00:00:00.000Z"), status: "upcoming" };
  assert.equal(eventExpiresAt(event).toISOString(), "2030-06-02T23:59:59.999Z");
  assert.equal(isActiveEvent(event, new Date("2030-06-02T12:00:00.000Z")), true);
  assert.equal(isActiveEvent(event, new Date("2030-06-03T00:00:00.000Z")), false);
  assert.equal(isActiveEvent({ ...event, status: "past" }, new Date("2030-06-01T00:00:00.000Z")), false);
  assert.equal(isActiveEvent({ ...event, date: "not-a-date" }, new Date("2030-06-01T00:00:00.000Z")), false);
});

test("hydrated pagination consumes stale rows until it fills the visible batch", () => {
  const rows = [
    { sourceId: "stale-1", sourceType: "item" },
    { sourceId: "visible-1", sourceType: "finspo" },
    { sourceId: "stale-2", sourceType: "event" },
    { sourceId: "visible-2", sourceType: "user" },
    { sourceId: "unconsumed", sourceType: "item" },
  ];
  const visible = new Set(["finspo:visible-1", "user:visible-2", "item:unconsumed"]);
  assert.equal(visiblePrefixLength(rows, visible, 2), 4);
  assert.equal(visiblePrefixLength(rows, visible, 10), rows.length);
});

test("item mapper includes public listing and live-shop aliases only", () => {
  const owner = {
    _id: new mongoose.Types.ObjectId(),
    accountStatus: "active",
    email: "private@example.com",
    username: "seller",
  };
  const shop = {
    _id: new mongoose.Types.ObjectId(),
    isLive: true,
    ownerId: owner._id,
    payoutMethod: { accountNumber: "private" },
    shopName: "Second Chance",
  };
  const listing = {
    _id: new mongoose.Types.ObjectId(),
    brand: "Levi's",
    category: "Denim",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    description: "Relaxed vintage jeans",
    hashtags: ["VintageDenim"],
    shopId: shop._id,
    status: "active",
    title: "Blue 501 jeans",
    type: "retail",
    updatedAt: new Date("2030-01-02T00:00:00.000Z"),
    visibility: "marketplace",
  };

  const document = mapListingSearchDocument({ listing, owner, shop });
  assert.equal(document.shopName, "Second Chance");
  assert.deepEqual(document.hashtags, ["vintagedenim"]);
  assert.ok(document.keywords.includes("levi's"));
  assert.equal("email" in document, false);
  assert.equal("payoutMethod" in document, false);
  assert.equal(mapListingSearchDocument({ listing: { ...listing, status: "sold" }, owner, shop }), null);
  assert.equal(mapListingSearchDocument({ listing, owner, shop: { ...shop, isLive: false } }), null);
});

test("Finspo mapper indexes saved tags while caption hashtags stay ordinary text", () => {
  const owner = {
    _id: new mongoose.Types.ObjectId(),
    accountStatus: "active",
    username: "creator",
  };
  const post = {
    _id: new mongoose.Types.ObjectId(),
    caption: "A layered look with #captionOnly",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    isArchived: false,
    tags: ["SavedTag"],
    updatedAt: new Date("2030-01-02T00:00:00.000Z"),
    userId: owner._id,
  };

  const document = mapFinspoSearchDocument({ owner, post });
  assert.deepEqual(document.hashtags, ["savedtag"]);
  assert.match(document.bodyText, /#captionOnly/);
  assert.equal(mapFinspoSearchDocument({ owner, post: { ...post, isArchived: true } }), null);
});

test("event mapper includes organizer, location, type and optional live-shop aliases", () => {
  const owner = {
    _id: new mongoose.Types.ObjectId(),
    accountStatus: "active",
    name: "Ama Mensah",
    username: "ama",
  };
  const shop = {
    _id: new mongoose.Types.ObjectId(),
    isLive: true,
    ownerId: owner._id,
    shopName: "Ama Archive",
  };
  const event = {
    _id: new mongoose.Types.ObjectId(),
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    date: new Date("2035-06-02T00:00:00.000Z"),
    description: "Community vintage market",
    location: "Accra Arts Centre",
    organizerId: owner._id,
    shopId: shop._id,
    status: "upcoming",
    title: "Sunday Rail Sale",
    type: "fair",
    updatedAt: new Date("2030-01-02T00:00:00.000Z"),
  };

  const document = mapEventSearchDocument({ event, owner, shop });
  assert.equal(document.shopName, "Ama Archive");
  assert.ok(document.keywords.includes("accra arts centre"));
  assert.ok(document.keywords.includes("ama mensah"));
  assert.equal(mapEventSearchDocument({ event, owner, shop: null }), null);
});

test("user mapper includes public profile/location and only live DigiShop identity", () => {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    accountStatus: "active",
    bio: "Vintage collector",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    email: "private@example.com",
    location: { city: "Kumasi", region: "Ashanti" },
    name: "Kojo Owusu",
    phone: "private",
    updatedAt: new Date("2030-01-02T00:00:00.000Z"),
    username: "kojo",
  };
  const shop = {
    _id: new mongoose.Types.ObjectId(),
    bio: "Curated menswear",
    category: "retail",
    isLive: true,
    shopName: "Kojo Selects",
  };

  const document = mapUserSearchDocument({ shop, user });
  assert.equal(document.shopName, "Kojo Selects");
  assert.ok(document.keywords.includes("kumasi"));
  assert.ok(document.keywords.includes("curated menswear"));
  assert.equal("email" in document, false);
  assert.equal("phone" in document, false);
  assert.equal(mapUserSearchDocument({ shop, user: { ...user, accountStatus: "deactivated" } }), null);
  assert.equal(mapUserSearchDocument({ shop: { ...shop, isLive: false }, user }).shopName, "");
});

test("signed keyset cursors preserve the search snapshot and reject reuse", () => {
  const id = new mongoose.Types.ObjectId();
  const snapshotAt = new Date("2030-02-01T12:00:00.000Z");
  const counts = { all: 40, events: 5, finspo: 10, items: 20, users: 5 };
  const after = sortPosition({
    _id: id,
    exactRank: 1,
    publishedAt: new Date("2030-01-15T12:00:00.000Z"),
    relevance: 7.25,
  });
  const cursor = encodeCursor({
    after,
    counts,
    fingerprint: "query-a",
    lastType: "item",
    run: 2,
    scanned: 12,
    snapshotAt,
  });
  assert.deepEqual(decodeCursor(cursor, "query-a"), {
    after,
    counts,
    lastType: "item",
    run: 2,
    scanned: 12,
    snapshotAt,
  });
  assert.throws(() => decodeCursor(cursor, "query-b"), /cursor is invalid/i);
  assert.throws(() => decodeCursor(`${cursor.slice(0, -1)}x`, "query-a"), /cursor is invalid/i);
  assert.throws(() => decodeCursor("not-a-cursor", "query-a"), /cursor is invalid/i);

  const match = afterSortMatch(after);
  assert.equal(match.$or.length, 4);
  assert.equal(String(match.$or[3]._id.$gt), String(id));
});

test("All search lightly diversifies similarly relevant result types", () => {
  const row = (sourceType, relevance = 10, exactRank = 0) => ({ sourceType, relevance, exactRank });
  const diversified = diversifyRows([
    row("item"),
    row("item"),
    row("item"),
    row("finspo", 9),
    row("event", 8),
  ]).rows;
  assert.deepEqual(diversified.map((entry) => entry.sourceType), ["item", "item", "finspo", "item", "event"]);

  const exactsStayFirst = diversifyRows([
    row("item", 10, 1),
    row("item", 10, 1),
    row("item", 10, 1),
    row("user", 10, 0),
  ]).rows;
  assert.deepEqual(exactsStayFirst.map((entry) => entry.sourceType), ["item", "item", "item", "user"]);

  const visibleRows = [row("item"), row("item"), row("event"), row("item"), row("user")]
    .filter((_, index) => index !== 2);
  assert.deepEqual(
    diversifyRows(visibleRows).rows.map((entry) => entry.sourceType),
    ["item", "item", "user", "item"],
  );
});

test("text search treats user punctuation as terms rather than Mongo operators", () => {
  assert.equal(textSearchExpression(" -dress vintage "), '"dress" "vintage"');
  assert.equal(textSearchExpression('"red coat"'), '"red" "coat"');
});

test("only a tracked first All request is eligible for anonymous search logging", () => {
  assert.equal(shouldLogUnifiedSearch({ scope: "all", track: "1" }), true);
  assert.equal(shouldLogUnifiedSearch({ cursor: "next", scope: "all", track: "1" }), false);
  assert.equal(shouldLogUnifiedSearch({ scope: "items", track: "1" }), false);
  assert.equal(shouldLogUnifiedSearch({ scope: "all" }), false);
});
