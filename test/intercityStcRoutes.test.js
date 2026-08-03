const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STOPS,
  destinationsForOrigin,
  isEligibleOrigin,
  isValidDestination,
} = require("../src/constants/intercityStcRoutes");

test("STC is eligible from any of its terminal towns, unlike 2M Express's 3 fixed origins", () => {
  assert.equal(isEligibleOrigin({ city: "Kumasi", region: "Ashanti" }), true);
  assert.equal(isEligibleOrigin({ city: "Wa", region: "Upper West" }), true);
  assert.equal(isEligibleOrigin({ city: "Ho", region: "Volta" }), true);
  assert.ok(STOPS.length > 20, "STC's terminal network should be far broader than 2M Express's 3 routes");
});

test("a seller outside every STC terminal town is not eligible", () => {
  assert.equal(isEligibleOrigin({ city: "Somewhere Remote", region: "Ashanti" }), false);
  assert.deepEqual(destinationsForOrigin({ city: "Somewhere Remote", region: "Ashanti" }), []);
});

test("destinations exclude terminals in the seller's own town but include every other terminal", () => {
  const destinations = destinationsForOrigin({ city: "Accra", region: "Greater Accra" });
  assert.ok(destinations.length > 30, "Accra should be able to route to most other terminals");
  assert.ok(!destinations.some((stop) => stop.town === "Accra"), "should not route to another Accra terminal");
  assert.ok(destinations.some((stop) => stop.town === "Kumasi"), "should include Kumasi as a destination");
  assert.ok(destinations.some((stop) => stop.town === "Takoradi"), "should include Takoradi as a destination");
});

test("multi-terminal towns (Accra, Kumasi, Takoradi, Tamale) are eligible origins keyed by city, not by a specific terminal", () => {
  assert.equal(isEligibleOrigin({ city: "Kumasi", region: "Ashanti" }), true);
  const kumasiTerminals = STOPS.filter((stop) => stop.town === "Kumasi");
  assert.deepEqual(
    kumasiTerminals.map((stop) => stop.terminal).sort(),
    ["Adum", "Asafo", "Labour", "Oforikrom"],
  );
});

test("a specific terminal (e.g. Kumasi (Asafo)) is a valid destination from an eligible origin", () => {
  const origin = { city: "Accra", region: "Greater Accra" };
  assert.equal(isValidDestination(origin, { region: "Ashanti", town: "Kumasi" }), true);
  assert.equal(isValidDestination(origin, { region: "Greater Accra", town: "Accra" }), false);
});

test("origin matching is case-insensitive and trims whitespace", () => {
  assert.equal(isEligibleOrigin({ city: "  kumasi  ", region: " ashanti " }), true);
});
