const test = require("node:test");
const assert = require("node:assert/strict");
const { BUS_FARE_TIER, estimateBusFarePesewas } = require("../src/constants/intercityBusFareEstimates");

test("Accra to Kumasi estimates a realistic standard-class ballpark", () => {
  const fare = estimateBusFarePesewas(
    { city: "Accra", region: "Greater Accra" },
    { region: "Ashanti", town: "Kumasi" },
  );
  // VIP Jeoun's real April-2026 standard fare is GHS 120 (12000 pesewas); the
  // estimate should be in the same order of magnitude, not wildly off.
  assert.ok(fare > 8000 && fare < 20000, `expected a plausible fare, got ${fare}`);
});

test("a longer route estimates a higher fare than a shorter one", () => {
  const short = estimateBusFarePesewas(
    { city: "Accra", region: "Greater Accra" },
    { region: "Central", town: "Cape Coast" },
  );
  const long = estimateBusFarePesewas(
    { city: "Accra", region: "Greater Accra" },
    { region: "Northern", town: "Tamale" },
  );
  assert.ok(long > short);
});

test("the estimate is clamped to the tier's min/max", () => {
  const sameTown = estimateBusFarePesewas(
    { city: "Accra", region: "Greater Accra" },
    { region: "Greater Accra", town: "Accra" },
  );
  assert.equal(sameTown, BUS_FARE_TIER.minFeePesewas);
});
