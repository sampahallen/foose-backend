const { GHANA_REGIONS } = require("./ghanaRegions");

/**
 * Door-to-door courier providers: two intra-city options (same region only)
 * and one inter-city option (cross-region only). Pricing tiers are
 * base-fare-plus-per-km, in pesewas (GHS x 100), matching the rest of the
 * app's money convention.
 *
 * Yango Delivery's tier is grounded in Yango's published Accra courier
 * tariff (minimum GHS 15, GHS 2.4/km, checked Aug 2026 at
 * yango.com/accra/tariff/courier/). Bolt Send has no public Ghana rate
 * card, so its tier is estimated slightly below Yango's to reflect Bolt's
 * generally competitive positioning in the same markets — confirm against
 * Bolt's live API/app before this is used for real charges. ShaQ Express
 * (inter-city) has no public rate card either; its tier is a rough estimate
 * benchmarked against Ghana intercity coach fares (which run well below a
 * dedicated door-to-door parcel service) — same caveat applies.
 */
const INTRA_CITY_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "bolt_send",
    name: "Bolt Send",
    // Full-region coverage.
    regions: Object.freeze(["Greater Accra", "Central", "Western", "Eastern", "Bono", "Volta"]),
    pricing: Object.freeze({
      baseFarePesewas: 1300,
      perKmPesewas: 220,
      minFeePesewas: 1300,
      maxFeePesewas: 12000,
    }),
    trackingNotice: "Track your delivery in real-time via the link above.",
  }),
  Object.freeze({
    id: "yango_delivery",
    name: "Yango Delivery",
    regions: Object.freeze(["Greater Accra", "Ashanti"]),
    pricing: Object.freeze({
      baseFarePesewas: 1500,
      perKmPesewas: 240,
      minFeePesewas: 1500,
      maxFeePesewas: 12000,
    }),
    trackingNotice: "Yango will send you SMS updates directly. You can also track via the link above.",
  }),
]);

/**
 * ShaQ Express operates in 9 of Ghana's 16 regions (confirmed as "nine
 * regions" on shaqexpress.com, Aug 2026). Any region outside this list -
 * e.g. Upper East/Upper West - has no inter-city courier option.
 */
const INTER_CITY_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "shaq_express",
    name: "ShaQ Express",
    regions: Object.freeze([
      "Greater Accra",
      "Ashanti",
      "Central",
      "Western",
      "Western North",
      "Eastern",
      "Volta",
      "Bono",
      "Northern",
    ]),
    pricing: Object.freeze({
      baseFarePesewas: 2000,
      perKmPesewas: 35,
      minFeePesewas: 2500,
      maxFeePesewas: 35000,
    }),
    trackingNotice: "Track your ShaQ Express delivery via the link above.",
  }),
]);

const ALL_PROVIDERS = Object.freeze([...INTRA_CITY_PROVIDERS, ...INTER_CITY_PROVIDERS]);

const PROVIDERS_BY_ID = Object.freeze(
  Object.fromEntries(ALL_PROVIDERS.map((provider) => [provider.id, provider])),
);

/** The one cross-region exception: a Greater Accra seller can reach a Kasoa (Central) buyer via Bolt Send only. */
const KASOA_TOWN = "Kasoa";
const KASOA_REGION = "Central";

const normalize = (value) => String(value || "").trim().toLowerCase();
const sameRegion = (a, b) => normalize(a) === normalize(b) && GHANA_REGIONS.some((r) => normalize(r) === normalize(a));
const coversRegion = (provider, region) => provider.regions.some((r) => normalize(r) === normalize(region));

/**
 * Which intra-city providers a buyer sees for this seller/buyer pair, per:
 * - same region required, EXCEPT a Greater Accra seller -> Kasoa buyer, which allows Bolt Send only.
 * - within the same region, a provider shows up only if it covers that region
 *   (so Greater Accra shows both, Ashanti shows Yango only, Central/Western/
 *   Eastern/Bono/Volta show Bolt only, and every other region shows neither).
 */
function getAvailableIntraCityProviders({ sellerRegion, buyerRegion, buyerTown } = {}) {
  const isKasoaException =
    normalize(sellerRegion) === normalize("Greater Accra") &&
    normalize(buyerRegion) === normalize(KASOA_REGION) &&
    normalize(buyerTown) === normalize(KASOA_TOWN);

  if (isKasoaException) {
    return INTRA_CITY_PROVIDERS.filter((provider) => provider.id === "bolt_send");
  }

  if (!sameRegion(sellerRegion, buyerRegion)) return [];

  return INTRA_CITY_PROVIDERS.filter((provider) => coversRegion(provider, sellerRegion));
}

/**
 * ShaQ Express shows up only when seller and buyer are in different regions
 * and BOTH regions are in its coverage list.
 */
function getAvailableInterCityProviders({ sellerRegion, buyerRegion } = {}) {
  if (normalize(sellerRegion) === normalize(buyerRegion)) return [];

  return INTER_CITY_PROVIDERS.filter(
    (provider) => coversRegion(provider, sellerRegion) && coversRegion(provider, buyerRegion),
  );
}

/**
 * Pure seller-side eligibility, ignoring the buyer entirely - used to
 * pre-disable/blur the top-level method card at checkout before the buyer
 * has entered a destination (e.g. a seller in Upper East never has an
 * intra-city option, regardless of where the buyer is).
 */
const isIntraCityCourierPossibleFrom = (sellerRegion) =>
  INTRA_CITY_PROVIDERS.some((provider) => coversRegion(provider, sellerRegion));

const isInterCityCourierPossibleFrom = (sellerRegion) =>
  INTER_CITY_PROVIDERS.some((provider) => coversRegion(provider, sellerRegion));

module.exports = {
  ALL_PROVIDERS,
  INTER_CITY_PROVIDERS,
  INTRA_CITY_PROVIDERS,
  KASOA_REGION,
  KASOA_TOWN,
  PROVIDERS_BY_ID,
  getAvailableInterCityProviders,
  getAvailableIntraCityProviders,
  isInterCityCourierPossibleFrom,
  isIntraCityCourierPossibleFrom,
};
