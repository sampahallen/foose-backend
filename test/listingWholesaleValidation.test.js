const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeListingTypeFields } = require("../src/controllers/listingController");
const { ATTRIBUTE_OPTIONS } = require("../src/utils/listingTaxonomy");

test("every listing is forced to a single unit, regardless of type", () => {
  const retail = normalizeListingTypeFields({ type: "retail", quantity: 50 });
  assert.equal(retail.quantity, 1);
  assert.equal(retail.bulkMinQty, undefined);

  const wholesale = normalizeListingTypeFields({
    attributes: { baleGrade: "grade-a" },
    bulkMinQty: 10,
    bulkWeight: "25kg",
    quantity: 200,
    type: "wholesale",
  });
  assert.equal(wholesale.quantity, 1);
  assert.equal(wholesale.bulkMinQty, undefined);
});

test("retail clears wholesale-only fields", () => {
  const input = normalizeListingTypeFields({
    bulkWeight: "25kg",
    type: "retail",
    volumeDiscounts: [{ minQty: 10, pricePerUnit: 500 }],
  });
  assert.equal(input.bulkWeight, undefined);
  assert.deepEqual(input.volumeDiscounts, []);
});

test("wholesale listings require a weight", () => {
  assert.throws(
    () => normalizeListingTypeFields({ attributes: { baleGrade: "grade-a" }, type: "wholesale" }),
    (error) => error.statusCode === 422 && /require a weight/.test(error.message),
  );
  assert.throws(
    () => normalizeListingTypeFields({ attributes: { baleGrade: "grade-a" }, bulkWeight: "   ", type: "wholesale" }),
    /require a weight/,
  );
});

test("wholesale listings require a bale grade", () => {
  assert.throws(
    () => normalizeListingTypeFields({ bulkWeight: "25kg", type: "wholesale" }),
    (error) => error.statusCode === 422 && /require a bale grade/.test(error.message),
  );
});

test("wholesale falls back to the current listing's weight and bale grade on an edit that doesn't resend them", () => {
  const currentListing = { attributes: { baleGrade: "mixed" }, bulkWeight: "25kg" };
  const input = normalizeListingTypeFields({ type: "wholesale" }, currentListing);
  assert.equal(input.quantity, 1);
});

test("a valid wholesale listing clears tiered volume pricing, since every bale is one unit now", () => {
  const input = normalizeListingTypeFields({
    attributes: { baleGrade: "grade-b" },
    bulkWeight: "25kg",
    type: "wholesale",
    volumeDiscounts: [{ minQty: 10, pricePerUnit: 500 }],
  });
  assert.deepEqual(input.volumeDiscounts, []);
});

test("\"wiper\" is a valid bale grade", () => {
  assert.ok(ATTRIBUTE_OPTIONS.baleGrade.has("wiper"));
  assert.doesNotThrow(() => normalizeListingTypeFields({
    attributes: { baleGrade: "wiper" },
    bulkWeight: "25kg",
    type: "wholesale",
  }));
});
