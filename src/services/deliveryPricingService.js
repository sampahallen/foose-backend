const {
  getAvailableInterCityProviders,
  getAvailableIntraCityProviders,
} = require("../constants/doorToDoorCourierProviders");
const { estimateDistanceKm } = require("../constants/ghanaCityDistances");

// Pure door-to-door courier pricing. Nothing here touches the database, so it
// stays unit-testable the same way bargainRules.js does. Distance-based fee
// estimates are a planning figure (see ghanaCityDistances.js) — good enough
// to show a live, dynamically-updating price at checkout, not a substitute
// for whatever the seller actually pays booking the trip in the provider's
// app (that's a two-way conversation between the seller and the courier;
// this only prices what the platform shows the buyer up front).

/**
 * base fare + per-km rate, clamped to the provider's min/max, in pesewas.
 */
function priceForProvider(provider, distanceKm) {
  const { baseFarePesewas, perKmPesewas, minFeePesewas, maxFeePesewas } = provider.pricing;
  const raw = baseFarePesewas + Math.round(distanceKm * perKmPesewas);
  return Math.min(maxFeePesewas, Math.max(minFeePesewas, raw));
}

function quoteProviders(providers, { sellerTown, sellerRegion, buyerTown, buyerRegion }) {
  const distanceKm = estimateDistanceKm({
    regionA: sellerRegion,
    regionB: buyerRegion,
    townA: sellerTown,
    townB: buyerTown,
  });

  return providers.map((provider) => ({
    distanceKm,
    feePesewas: priceForProvider(provider, distanceKm),
    providerId: provider.id,
    providerName: provider.name,
    trackingNotice: provider.trackingNotice,
  }));
}

/**
 * Intra-city options (Bolt Send / Yango Delivery) available for this seller
 * -> buyer pair, each with a live distance-based price. Empty array means the
 * checkout option should be blurred/disabled - the seller/buyer combination
 * isn't eligible for either provider.
 */
function getIntraCityQuotes({ sellerTown, sellerRegion, buyerTown, buyerRegion } = {}) {
  const providers = getAvailableIntraCityProviders({ buyerRegion, buyerTown, sellerRegion });
  if (!providers.length) return [];
  return quoteProviders(providers, { buyerRegion, buyerTown, sellerRegion, sellerTown });
}

/**
 * Inter-city option (ShaQ Express) for this seller -> buyer pair, or null if
 * unavailable (same region, or either region outside ShaQ's coverage).
 */
function getInterCityQuote({ sellerTown, sellerRegion, buyerTown, buyerRegion } = {}) {
  const providers = getAvailableInterCityProviders({ buyerRegion, sellerRegion });
  if (!providers.length) return null;
  return quoteProviders(providers, { buyerRegion, buyerTown, sellerRegion, sellerTown })[0];
}

module.exports = {
  getInterCityQuote,
  getIntraCityQuotes,
  priceForProvider,
};
