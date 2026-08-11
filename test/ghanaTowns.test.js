const test = require("node:test");
const assert = require("node:assert/strict");
const { GHANA_REGIONS } = require("../src/constants/ghanaRegions");
const {
  GHANA_TOWNS_BY_REGION,
  isValidTown,
  regionForTown,
  townsForRegion,
} = require("../src/constants/ghanaTowns");

test("every Ghana region has its own non-empty town list", () => {
  for (const region of GHANA_REGIONS) {
    const towns = townsForRegion(region);
    assert.ok(Array.isArray(towns) && towns.length > 0, `${region} should list towns`);
  }
});

test("no unexpected region keys sneak into the town map", () => {
  assert.deepEqual(Object.keys(GHANA_TOWNS_BY_REGION).sort(), [...GHANA_REGIONS].sort());
});

test("isValidTown matches case-insensitively and trims whitespace", () => {
  assert.equal(isValidTown("Greater Accra", "accra"), true);
  assert.equal(isValidTown("Greater Accra", "  Kasoa  "), false);
  assert.equal(isValidTown("Central", "  kasoa  "), true);
});

test("regionForTown finds the owning region regardless of case", () => {
  assert.equal(regionForTown("kumasi"), "Ashanti");
  assert.equal(regionForTown("Sefwi Wiawso"), "Western North");
  assert.equal(regionForTown("Nonexistent Town"), undefined);
});
