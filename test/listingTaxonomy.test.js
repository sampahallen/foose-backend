const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isSupportedCategory,
  normalizeCategoryFields,
  normalizeCategorySelection,
  parseAttributes,
} = require("../src/utils/listingTaxonomy");
const { legacyListingUpdate } = require("../src/services/listingTaxonomyMigrationService");

test("listing taxonomy recognizes supported categories", () => {
  assert.equal(isSupportedCategory("Clothing"), true);
  assert.equal(isSupportedCategory("Wholesale Bales"), false);
  assert.equal(isSupportedCategory("Not a category"), false);
});

test("listing taxonomy normalizes legacy categories and validates subcategories", () => {
  assert.deepEqual(
    normalizeCategorySelection("T-Shirts", ""),
    {
      category: "Clothing",
      legacyHashtag: undefined,
      subcategory: "Tops & Shirts",
      validCategory: true,
      validSubcategory: true,
      wasLegacy: true,
    },
  );
  assert.equal(normalizeCategorySelection("Footwear", "Dresses").validSubcategory, false);
});

test("listing taxonomy removes fields that do not apply and adds bale grade by type", () => {
  const input = {
    brand: "Nike",
    size: "XL",
    attributes: { baleGrade: "grade-a", material: "cotton" },
  };
  normalizeCategoryFields(input, "Accessories", {
    replaceAttributes: true,
    subcategory: "Jewelry & Watches",
    type: "wholesale",
  });
  assert.equal(input.brand, "Nike");
  assert.equal(input.size, undefined);
  assert.deepEqual(input.attributes, { baleGrade: "grade-a", material: "cotton" });
});

test("listing taxonomy rejects invalid or unknown attributes", () => {
  assert.throws(
    () => normalizeCategoryFields({ attributes: { fit: "boxy" } }, "Clothing", { replaceAttributes: true }),
    /Invalid fit/,
  );
  assert.throws(
    () => normalizeCategoryFields({ attributes: { secret: "value" } }, "Other", { replaceAttributes: true }),
    /Unknown listing attribute/,
  );
  assert.deepEqual(parseAttributes('{"material":"linen"}'), { material: "linen" });
});

test("legacy migration mappings are idempotent and preserve discovery data", () => {
  assert.deepEqual(legacyListingUpdate({ category: "Kids", gender: "" }), {
    category: "Clothing",
    gender: "kids",
    subcategory: "Other Clothing",
  });
  assert.deepEqual(legacyListingUpdate({ category: "Vintage", hashtags: ["rare", "vintage"] }), {
    category: "Other",
    hashtags: ["rare", "vintage"],
    subcategory: undefined,
  });
  assert.equal(legacyListingUpdate({ category: "Clothing", subcategory: "Outerwear" }), null);
});
