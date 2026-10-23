const test = require("node:test");
const assert = require("node:assert/strict");
const Listing = require("../src/models/Listing");
const { listingBody } = require("../src/routes/listingRoutes");
const { appendColorFilter, effectiveListingColors, normalizeListingColorFields } = require("../src/utils/listingColors");

test("listing request accepts up to five distinct colors and rejects Multi with named colors", () => {
  assert.deepEqual(listingBody.parse({ colors: '["red","blue"]' }).colors, ["red", "blue"]);
  assert.equal(listingBody.safeParse({ colors: '["red","red"]' }).success, false);
  assert.equal(listingBody.safeParse({ colors: '["multi","red"]' }).success, false);
  assert.equal(listingBody.safeParse({ colors: '["red","blue","green","white","black","navy"]' }).success, false);
  assert.equal(listingBody.safeParse({ colors: '["unknown"]' }).success, false);
});

test("new and edited listings keep the legacy color in sync", () => {
  assert.deepEqual(normalizeListingColorFields({ type: "retail" }), { type: "retail", color: "multi", colors: ["multi"] });
  assert.deepEqual(normalizeListingColorFields({ colors: ["red", "blue"] }), { color: "red", colors: ["red", "blue"] });
  assert.deepEqual(normalizeListingColorFields({ color: "navy" }, { color: "red", colors: ["red", "blue"] }), { color: "navy", colors: ["navy"] });
  assert.deepEqual(normalizeListingColorFields({ title: "Updated" }, { color: "red" }), { title: "Updated" });
  assert.deepEqual(effectiveListingColors({ color: "red" }), ["red"]);
  assert.deepEqual(effectiveListingColors({ color: "red", colors: ["red", "blue"] }), ["red", "blue"]);
});

test("schema and browse filter support multiple and legacy colors", () => {
  const listing = new Listing({ colors: ["red", "blue"], color: "red" });
  assert.equal(listing.validateSync()?.errors?.colors, undefined);
  listing.colors = ["multi", "blue"];
  assert.ok(listing.validateSync()?.errors?.colors);
  assert.deepEqual(appendColorFilter({ status: "active" }, "blue"), {
    status: "active",
    $and: [{ $or: [{ colors: "blue" }, { color: "blue" }] }],
  });
});
