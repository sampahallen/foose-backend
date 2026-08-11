const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getAvailableInterCityProviders,
  getAvailableIntraCityProviders,
} = require("../src/constants/doorToDoorCourierProviders");

function ids(providers) {
  return providers.map((provider) => provider.id).sort();
}

test("Greater Accra seller and buyer see both Bolt Send and Yango Delivery", () => {
  const providers = getAvailableIntraCityProviders({
    buyerRegion: "Greater Accra",
    buyerTown: "Tema",
    sellerRegion: "Greater Accra",
  });
  assert.deepEqual(ids(providers), ["bolt_send", "yango_delivery"]);
});

test("Ashanti seller and buyer see Yango Delivery only (Bolt Send doesn't cover Ashanti)", () => {
  const providers = getAvailableIntraCityProviders({
    buyerRegion: "Ashanti",
    buyerTown: "Obuasi",
    sellerRegion: "Ashanti",
  });
  assert.deepEqual(ids(providers), ["yango_delivery"]);
});

test("Central seller and buyer see Bolt Send only (Yango doesn't cover Central)", () => {
  const providers = getAvailableIntraCityProviders({
    buyerRegion: "Central",
    buyerTown: "Cape Coast",
    sellerRegion: "Central",
  });
  assert.deepEqual(ids(providers), ["bolt_send"]);
});

test("a region neither courier covers (e.g. Northern) has no intra-city option", () => {
  const providers = getAvailableIntraCityProviders({
    buyerRegion: "Northern",
    buyerTown: "Tamale",
    sellerRegion: "Northern",
  });
  assert.deepEqual(providers, []);
});

test("cross-region intra-city is blocked, except the Greater Accra seller -> Kasoa buyer exception (Bolt Send only)", () => {
  assert.deepEqual(
    getAvailableIntraCityProviders({ buyerRegion: "Ashanti", buyerTown: "Kumasi", sellerRegion: "Greater Accra" }),
    [],
  );

  const kasoaException = getAvailableIntraCityProviders({
    buyerRegion: "Central",
    buyerTown: "Kasoa",
    sellerRegion: "Greater Accra",
  });
  assert.deepEqual(ids(kasoaException), ["bolt_send"]);

  // A Western-region seller reaching a Kasoa buyer is cross-region and NOT the
  // Greater-Accra-only exception, so it gets nothing.
  assert.deepEqual(
    getAvailableIntraCityProviders({ buyerRegion: "Central", buyerTown: "Kasoa", sellerRegion: "Western" }),
    [],
  );

  // A Central-region seller reaching a Kasoa buyer is same-region (not the
  // exception at all) and follows the normal Central coverage rule: Bolt only.
  assert.deepEqual(
    ids(getAvailableIntraCityProviders({ buyerRegion: "Central", buyerTown: "Kasoa", sellerRegion: "Central" })),
    ["bolt_send"],
  );
});

test("ShaQ Express appears only across two different regions it both covers", () => {
  assert.deepEqual(
    ids(getAvailableInterCityProviders({ buyerRegion: "Ashanti", sellerRegion: "Greater Accra" })),
    ["shaq_express"],
  );
  // Same region -> that's intra-city territory, not inter-city.
  assert.deepEqual(getAvailableInterCityProviders({ buyerRegion: "Ashanti", sellerRegion: "Ashanti" }), []);
  // Upper East isn't in ShaQ's coverage list.
  assert.deepEqual(
    getAvailableInterCityProviders({ buyerRegion: "Upper East", sellerRegion: "Greater Accra" }),
    [],
  );
});
