const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const DigiShop = require("../src/models/DigiShop");
const Listing = require("../src/models/Listing");
const SearchDocument = require("../src/models/SearchDocument");
const User = require("../src/models/User");
const searchRouter = require("../src/routes/searchRoutes");
const {
  browseDocumentMatchesPrefix,
  browseSuggestions,
  buildBrowseListingFilter,
  unifiedSuggestions,
} = require("../src/services/searchQueryService");

const queryResult = (value) => {
  const query = {};
  ["limit", "select", "skip", "sort"].forEach((method) => {
    query[method] = () => query;
  });
  query.lean = async () => value;
  return query;
};

test("Browse suggestion validation is additive and enforces item filter constraints", () => {
  const schema = searchRouter.suggestionQuerySchema;
  assert.equal(schema.safeParse({ q: "dr" }).success, true);
  assert.equal(schema.safeParse({ q: "d" }).success, false);
  assert.equal(schema.safeParse({ brand: "Nike", q: "ni" }).success, false);

  const parsed = schema.safeParse({
    brand: "Nike",
    category: "Sneakers",
    maxPrice: "500.75",
    minPrice: "100.25",
    q: "ni",
    scope: "items",
    type: "retail",
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.minPrice, 100.25);
  assert.equal(parsed.data.maxPrice, 500.75);
  assert.equal(schema.safeParse({ maxPrice: 100, minPrice: 200, q: "ni", scope: "items" }).success, false);
  assert.equal(schema.safeParse({ q: "ni", scope: "users" }).success, false);
});

test("Browse prefix matching ignores shop-only aliases", () => {
  const document = {
    hashtags: ["vintagefind"],
    keywords: ["Dresses", "Acme"],
    primaryNormalized: "red evening dress",
    shopNameNormalized: "violet closet",
    username: "vintage_seller",
  };
  assert.equal(browseDocumentMatchesPrefix(document, "dress"), true);
  assert.equal(browseDocumentMatchesPrefix(document, "vint"), true);
  assert.equal(browseDocumentMatchesPrefix({ ...document, hashtags: [] }, "viol"), false);
});

test("Browse listing filters preserve every marketplace constraint including legacy location", async () => {
  const originalShopFind = DigiShop.find;
  const legacyShopId = new mongoose.Types.ObjectId();
  DigiShop.find = () => queryResult([{ _id: legacyShopId }]);

  try {
    const filter = await buildBrowseListingFilter({
      brand: "Nike",
      category: "Sneakers",
      color: "blue",
      condition: "great",
      gender: "unisex",
      location: "Accra, Greater Accra",
      maxPrice: 900,
      minPrice: 100,
      size: "UK 8",
      type: "retail",
    });
    assert.deepEqual(filter.price, { $gte: 100, $lte: 900 });
    assert.equal(filter.brand, "Nike");
    assert.equal(filter.category, "Sneakers");
    assert.equal(filter.color, "blue");
    assert.equal(filter.condition, "great");
    assert.equal(filter.gender, "unisex");
    assert.equal(filter.size, "UK 8");
    assert.equal(filter.type, "retail");
    assert.equal(filter.$and.length, 1);
    assert.ok(filter.$and[0].$or.some((clause) => clause.$and?.[1]?.shopId?.$in?.includes(legacyShopId)));
  } finally {
    DigiShop.find = originalShopFind;
  }
});

test("item-scoped suggestions apply filters, recheck visibility, and cap the 4/5 mix", async () => {
  const original = {
    digishopFind: DigiShop.find,
    listingFind: Listing.find,
    searchFind: SearchDocument.find,
    userFind: User.find,
  };
  const ownerId = new mongoose.Types.ObjectId();
  const inactiveOwnerId = new mongoose.Types.ObjectId();
  const liveShopId = new mongoose.Types.ObjectId();
  const hiddenShopId = new mongoose.Types.ObjectId();
  const inactiveOwnerShopId = new mongoose.Types.ObjectId();
  const ids = Array.from({ length: 12 }, () => new mongoose.Types.ObjectId());
  const brands = ["Vintage Co", "Vintage Co", "Vinyl", "Vivid", "Viola", "Viking", "Vinta", "Vine"];
  const documents = ids.map((sourceId, index) => ({
    hashtags: index === 11 ? [] : ["vintage"],
    keywords: index === 11 ? ["shirts"] : [brands[index % brands.length], index === 8 ? "Bags" : "Dresses"],
    primaryNormalized: index === 11 ? "plain shirt" : `vintage dress ${index}`,
    publishedAt: new Date(`2030-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
    sourceId,
    sourceType: "item",
  }));
  const listings = ids.map((id, index) => ({
    _id: id,
    brand: brands[index % brands.length],
    category: index === 8 ? "Bags" : "Dresses",
    createdAt: documents[index].publishedAt,
    currency: "GHS",
    hashtags: index === 11 ? [] : ["vintage"],
    images: [`https://example.com/${index}.jpg`],
    price: index === 9 ? 800 : 250,
    shopId: index === 6 ? hiddenShopId : index === 7 ? inactiveOwnerShopId : liveShopId,
    status: "active",
    title: index === 11 ? "Plain shirt" : `Vintage dress ${index}`,
    type: "retail",
    visibility: "marketplace",
  }));
  let listingFilter;

  SearchDocument.find = (filter) => {
    assert.equal(filter.sourceType, "item");
    assert.equal(filter.autocompleteTokens, "vi");
    return queryResult(documents);
  };
  Listing.find = (filter) => {
    listingFilter = filter;
    const allowedIds = new Set(filter._id.$in.map(String));
    const rows = listings.filter((listing) =>
      allowedIds.has(String(listing._id)) &&
      listing.type === filter.type &&
      listing.category === filter.category &&
      listing.price >= filter.price.$gte &&
      listing.price <= filter.price.$lte);
    return queryResult(rows);
  };
  DigiShop.find = () => queryResult([
    { _id: liveShopId, isLive: true, ownerId, shopName: "Visible shop", slug: "visible-shop" },
    { _id: hiddenShopId, isLive: false, ownerId, shopName: "Hidden shop", slug: "hidden-shop" },
    { _id: inactiveOwnerShopId, isLive: true, ownerId: inactiveOwnerId, shopName: "Inactive shop", slug: "inactive-shop" },
  ]);
  User.find = () => queryResult([{ _id: ownerId, accountStatus: "active" }]);

  try {
    const result = await browseSuggestions({
      category: "Dresses",
      limit: 10,
      maxPrice: 500,
      minPrice: 100,
      q: "vi",
      type: "retail",
    });
    const terms = result.suggestions.filter((suggestion) => suggestion.kind === "term");
    const entities = result.suggestions.filter((suggestion) => suggestion.kind === "entity");

    assert.equal(result.suggestions.length, 9);
    assert.equal(terms.length, 4);
    assert.equal(entities.length, 5);
    assert.ok(terms.every((term) => ["brand", "category", "hashtag"].includes(term.type)));
    assert.deepEqual(
      terms.find((term) => term.type === "hashtag"),
      { count: 7, kind: "term", label: "#vintage", type: "hashtag", value: "vintage" },
    );
    assert.ok(entities.every((suggestion) => suggestion.type === "item" && suggestion.href.startsWith("/listing/")));
    assert.ok(entities.every((suggestion) => suggestion.entity.shopId.shopName === "Visible shop"));
    assert.equal(listingFilter.type, "retail");
    assert.equal(listingFilter.category, "Dresses");
    assert.deepEqual(listingFilter.price, { $gte: 100, $lte: 500 });
    assert.equal(listingFilter._id.$in.some((id) => String(id) === String(ids[11])), false);
  } finally {
    DigiShop.find = original.digishopFind;
    Listing.find = original.listingFind;
    SearchDocument.find = original.searchFind;
    User.find = original.userFind;
  }
});

test("suggestions without scope retain the unified entity contract", async () => {
  const original = {
    aggregate: SearchDocument.aggregate,
    digishopFind: DigiShop.find,
    listingFind: Listing.find,
    searchFind: SearchDocument.find,
    userFind: User.find,
  };
  const ownerId = new mongoose.Types.ObjectId();
  const shopId = new mongoose.Types.ObjectId();
  const listingId = new mongoose.Types.ObjectId();
  const document = {
    primaryNormalized: "vintage dress",
    publishedAt: new Date("2030-01-01T00:00:00.000Z"),
    shopNameNormalized: "visible shop",
    sourceId: listingId,
    sourceType: "item",
    username: "seller",
  };
  SearchDocument.find = () => queryResult([document]);
  SearchDocument.aggregate = async () => [];
  Listing.find = () => queryResult([{
    _id: listingId,
    images: ["https://example.com/item.jpg"],
    shopId,
    status: "active",
    title: "Vintage dress",
    visibility: "marketplace",
  }]);
  DigiShop.find = () => queryResult([{
    _id: shopId,
    isLive: true,
    ownerId,
    shopName: "Visible shop",
    slug: "visible-shop",
  }]);
  User.find = () => queryResult([{ _id: ownerId, accountStatus: "active" }]);

  try {
    const result = await unifiedSuggestions({ limit: 1, q: "vi" });
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].kind, "entity");
    assert.equal(result.suggestions[0].type, "item");
    assert.equal(result.suggestions[0].label, "Vintage dress");
  } finally {
    SearchDocument.aggregate = original.aggregate;
    DigiShop.find = original.digishopFind;
    Listing.find = original.listingFind;
    SearchDocument.find = original.searchFind;
    User.find = original.userFind;
  }
});
