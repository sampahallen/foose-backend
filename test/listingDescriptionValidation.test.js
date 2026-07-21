const test = require("node:test");
const assert = require("node:assert/strict");
const Listing = require("../src/models/Listing");
const listingRoutes = require("../src/routes/listingRoutes");

test("listing descriptions are limited to 500 characters at the API boundary", () => {
  assert.equal(listingRoutes.listingBody.safeParse({ description: "a".repeat(500) }).success, true);
  assert.equal(listingRoutes.listingBody.safeParse({ description: "a".repeat(501) }).success, false);
});

test("the listing model retains the 500-character description constraint", () => {
  assert.equal(Listing.schema.path("description").options.maxlength, 500);
});
