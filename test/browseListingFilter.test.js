const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBrowseListingFilter } = require("../src/services/searchQueryService");

test("browse listing filters map attributes and GHS prices to storage fields", async () => {
  const filter = await buildBrowseListingFilter({
    category: "Outerwear",
    fit: "relaxed",
    material: "cotton",
    minPrice: 12.5,
    maxPrice: 40,
  });

  assert.equal(filter.category, "Clothing");
  assert.equal(filter.subcategory, "Outerwear");
  assert.equal(filter["attributes.fit"], "relaxed");
  assert.equal(filter["attributes.material"], "cotton");
  assert.deepEqual(filter.price, { $gte: 1250, $lte: 4000 });
});
