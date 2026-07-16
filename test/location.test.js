const test = require("node:test");
const assert = require("node:assert/strict");
const {
  effectiveListingLocation,
  hasCompleteLocation,
  locationMatches,
  locationMatchQuery,
  mergeLocation,
  normalizeLocation,
} = require("../src/utils/location");
const {
  ensureShopLocationFromOwner,
  fillIncompleteListingLocations,
} = require("../src/services/locationService");

test("shop locations normalize whitespace and fill missing fields from account defaults", () => {
  assert.deepEqual(
    mergeLocation(
      { city: "  Kumasi  " },
      { city: "Accra", region: "  Ashanti   Region " },
    ),
    { city: "Kumasi", region: "Ashanti Region" },
  );
  assert.equal(hasCompleteLocation({ city: "Kumasi", region: "Ashanti" }), true);
  assert.equal(hasCompleteLocation({ city: "", region: "Ashanti" }), false);
});

test("location values match by city, region, or their combined label", () => {
  const location = { city: "Accra", region: "Greater Accra" };

  assert.equal(locationMatches(location, "accra"), true);
  assert.equal(locationMatches(location, "GREATER ACCRA"), true);
  assert.equal(locationMatches(location, "Accra, Greater Accra"), true);
  assert.equal(locationMatches(location, "Kumasi"), false);
});

test("location database clauses support region-only and city-region filters", () => {
  const regionQuery = locationMatchQuery("Greater Accra");
  assert.equal(regionQuery.$or[0]["location.city"].test("greater accra"), true);
  assert.equal(regionQuery.$or[1]["location.region"].test("Greater Accra"), true);
  assert.equal(regionQuery.$or[1]["location.region"].test("Greater Accra North"), false);

  const combinedQuery = locationMatchQuery("Accra, Greater Accra");
  assert.equal(combinedQuery["location.city"].test("Accra"), true);
  assert.equal(combinedQuery["location.region"].test("Greater Accra"), true);
});

test("listing snapshots take precedence while legacy listings fill gaps from their shop", () => {
  assert.deepEqual(
    effectiveListingLocation({
      location: { city: "Takoradi", region: "Western" },
      shopId: { location: { city: "Accra", region: "Greater Accra" } },
    }),
    { city: "Takoradi", region: "Western" },
  );

  assert.deepEqual(
    effectiveListingLocation({
      location: { city: "" },
      shopId: { location: { city: "Tamale", region: "Northern" } },
    }),
    normalizeLocation({ city: "Tamale", region: "Northern" }),
  );
});

test("legacy shops persist a complete account location but never persist a partial one", async () => {
  const listingUpdates = [];
  const ListingModel = {
    updateMany: async (filter, update) => {
      listingUpdates.push({ filter, update });
      return { modifiedCount: 3 };
    },
  };
  let completeSaves = 0;
  const completeShop = {
    _id: "shop-1",
    location: {},
    ownerId: "owner-1",
    save: async () => { completeSaves += 1; },
  };
  const completeResult = await ensureShopLocationFromOwner(completeShop, {
    location: { city: "Cape Coast", region: "Central" },
  }, ListingModel);

  assert.equal(completeResult.changed, true);
  assert.deepEqual(completeResult.location, { city: "Cape Coast", region: "Central" });
  assert.deepEqual(completeShop.location, completeResult.location);
  assert.equal(completeSaves, 1);
  assert.equal(completeResult.listingsUpdated, 3);
  assert.equal(listingUpdates.length, 1);
  assert.equal(listingUpdates[0].filter.shopId, "shop-1");
  assert.ok(Array.isArray(listingUpdates[0].filter.$or));
  assert.deepEqual(listingUpdates[0].update, {
    $set: { location: { city: "Cape Coast", region: "Central" } },
  });

  let partialSaves = 0;
  const partialShop = {
    location: {},
    ownerId: "owner-2",
    save: async () => { partialSaves += 1; },
  };
  const partialResult = await ensureShopLocationFromOwner(partialShop, {
    location: { region: "Volta" },
  }, ListingModel);

  assert.equal(partialResult.changed, false);
  assert.deepEqual(partialResult.location, { city: "", region: "Volta" });
  assert.deepEqual(partialShop.location, {});
  assert.equal(partialSaves, 0);
  assert.equal(partialResult.listingsUpdated, 0);
  assert.equal(listingUpdates.length, 1);
});

test("legacy listing repair refuses incomplete locations", async () => {
  let calls = 0;
  const ListingModel = {
    updateMany: async () => {
      calls += 1;
      return { modifiedCount: 1 };
    },
  };

  assert.equal(
    await fillIncompleteListingLocations("shop-1", { city: "Accra" }, ListingModel),
    0,
  );
  assert.equal(calls, 0);
});
