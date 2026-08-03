const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STOPS,
  destinationsForOrigin,
  isEligibleOrigin,
  isValidDestination,
} = require("../src/constants/vipJeounRoutes");

test("a seller in Accra, the hub, can route to any spoke town", () => {
  const destinations = destinationsForOrigin({ city: "Accra", region: "Greater Accra" });
  assert.equal(destinations.length, STOPS.length - 1);
  assert.ok(destinations.some((stop) => stop.town === "Kumasi"));
  assert.ok(destinations.some((stop) => stop.town === "Wa"));
  assert.ok(!destinations.some((stop) => stop.town === "Accra"), "should not route to itself");
});

test("a seller in a spoke town can only route back to Accra", () => {
  const destinations = destinationsForOrigin({ city: "Kumasi", region: "Ashanti" });
  assert.deepEqual(destinations, [{ region: "Greater Accra", terminal: "", town: "Accra" }]);
  assert.equal(isValidDestination({ city: "Kumasi", region: "Ashanti" }, { region: "Western", town: "Sehwi" }), false);
});

test("a seller outside the network is not eligible", () => {
  assert.equal(isEligibleOrigin({ city: "Somewhere Remote", region: "Volta" }), false);
  assert.deepEqual(destinationsForOrigin({ city: "Somewhere Remote", region: "Volta" }), []);
});

test("Accra to Kumasi and Kumasi to Accra are both valid, but Sunyani to Kumasi is not (no direct spoke-to-spoke routes)", () => {
  assert.equal(isValidDestination({ city: "Accra", region: "Greater Accra" }, { region: "Ashanti", town: "Kumasi" }), true);
  assert.equal(isValidDestination({ city: "Kumasi", region: "Ashanti" }, { region: "Greater Accra", town: "Accra" }), true);
  assert.equal(isValidDestination({ city: "Sunyani", region: "Bono" }, { region: "Ashanti", town: "Kumasi" }), false);
});

test("origin matching is case-insensitive and trims whitespace", () => {
  assert.equal(isEligibleOrigin({ city: "  accra  ", region: " greater accra " }), true);
});
