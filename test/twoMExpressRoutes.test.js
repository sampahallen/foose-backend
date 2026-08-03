const test = require("node:test");
const assert = require("node:assert/strict");
const {
  destinationsForOrigin,
  isEligibleOrigin,
  isValidDestination,
} = require("../src/constants/twoMExpressRoutes");

test("a seller anywhere in Greater Accra can route to Kumasi(Asafo) or Takoradi", () => {
  const destinations = destinationsForOrigin({ city: "East Legon", region: "Greater Accra" });
  assert.deepEqual(
    destinations.map((stop) => `${stop.region}:${stop.town}`),
    ["Ashanti:Kumasi", "Western:Takoradi"],
  );
  assert.equal(isValidDestination({ region: "Greater Accra" }, { region: "Ashanti", town: "Kumasi" }), true);
  assert.equal(isValidDestination({ region: "Greater Accra" }, { region: "Western", town: "Takoradi" }), true);
  assert.equal(isValidDestination({ region: "Greater Accra" }, { region: "Greater Accra", town: "Accra" }), false);
});

test("a seller in Kasoa (Central) can only route to Kumasi", () => {
  const origin = { city: "Kasoa", region: "Central" };
  assert.equal(isEligibleOrigin(origin), true);
  assert.deepEqual(
    destinationsForOrigin(origin).map((stop) => stop.town),
    ["Kumasi"],
  );
  assert.equal(isValidDestination(origin, { region: "Western", town: "Takoradi" }), false);
});

test("a seller in Kumasi (Ashanti) can only route to Accra(Circle)", () => {
  const origin = { city: "Kumasi", region: "Ashanti" };
  assert.deepEqual(
    destinationsForOrigin(origin),
    [{ region: "Greater Accra", terminal: "Circle", town: "Accra" }],
  );
  assert.equal(isValidDestination(origin, { region: "Greater Accra", town: "Accra" }), true);
});

test("a seller outside the eligible origins has no 2M Express route", () => {
  assert.equal(isEligibleOrigin({ city: "Ho", region: "Volta" }), false);
  assert.deepEqual(destinationsForOrigin({ city: "Cape Coast", region: "Central" }), []);
});

test("origin matching is case-insensitive and trims whitespace", () => {
  assert.equal(isEligibleOrigin({ city: "  kasoa  ", region: " central " }), true);
});
