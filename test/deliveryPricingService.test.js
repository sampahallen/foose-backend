const test = require("node:test");
const assert = require("node:assert/strict");
const { PROVIDERS_BY_ID } = require("../src/constants/doorToDoorCourierProviders");
const {
  getInterCityQuote,
  getIntraCityQuotes,
  priceForProvider,
} = require("../src/services/deliveryPricingService");

test("priceForProvider is base fare + per-km, clamped to the provider's min/max", () => {
  const provider = PROVIDERS_BY_ID.bolt_send;
  assert.equal(priceForProvider(provider, 0), provider.pricing.minFeePesewas);
  assert.equal(
    priceForProvider(provider, 10),
    provider.pricing.baseFarePesewas + 10 * provider.pricing.perKmPesewas,
  );
  assert.equal(priceForProvider(provider, 100000), provider.pricing.maxFeePesewas);
});

test("intra-city quotes return one priced option per available provider, and update with the buyer's town", () => {
  const nearby = getIntraCityQuotes({
    buyerRegion: "Greater Accra",
    buyerTown: "Tema",
    sellerRegion: "Greater Accra",
    sellerTown: "Accra",
  });
  assert.deepEqual(
    nearby.map((quote) => quote.providerId).sort(),
    ["bolt_send", "yango_delivery"],
  );
  assert.ok(nearby.every((quote) => quote.feePesewas > 0 && quote.distanceKm > 0));

  const farther = getIntraCityQuotes({
    buyerRegion: "Greater Accra",
    buyerTown: "Ada Foah",
    sellerRegion: "Greater Accra",
    sellerTown: "Accra",
  });
  const nearbyBolt = nearby.find((quote) => quote.providerId === "bolt_send");
  const fartherBolt = farther.find((quote) => quote.providerId === "bolt_send");
  assert.ok(fartherBolt.distanceKm > nearbyBolt.distanceKm);
  assert.ok(fartherBolt.feePesewas >= nearbyBolt.feePesewas);
});

test("intra-city quotes are empty where no provider covers the region", () => {
  assert.deepEqual(
    getIntraCityQuotes({
      buyerRegion: "Northern",
      buyerTown: "Tamale",
      sellerRegion: "Northern",
      sellerTown: "Yendi",
    }),
    [],
  );
});

test("inter-city quote prices the Accra-Kumasi route using the curated distance matrix", () => {
  const quote = getInterCityQuote({
    buyerRegion: "Ashanti",
    buyerTown: "Kumasi",
    sellerRegion: "Greater Accra",
    sellerTown: "Accra",
  });
  assert.equal(quote.providerId, "shaq_express");
  assert.equal(quote.distanceKm, 250);
  const expectedFee = Math.min(
    PROVIDERS_BY_ID.shaq_express.pricing.maxFeePesewas,
    Math.max(
      PROVIDERS_BY_ID.shaq_express.pricing.minFeePesewas,
      PROVIDERS_BY_ID.shaq_express.pricing.baseFarePesewas + 250 * PROVIDERS_BY_ID.shaq_express.pricing.perKmPesewas,
    ),
  );
  assert.equal(quote.feePesewas, expectedFee);
});

test("inter-city quote is null when regions match or either region is outside ShaQ's coverage", () => {
  assert.equal(
    getInterCityQuote({
      buyerRegion: "Greater Accra",
      buyerTown: "Tema",
      sellerRegion: "Greater Accra",
      sellerTown: "Accra",
    }),
    null,
  );
  assert.equal(
    getInterCityQuote({
      buyerRegion: "Upper West",
      buyerTown: "Wa",
      sellerRegion: "Greater Accra",
      sellerTown: "Accra",
    }),
    null,
  );
});
