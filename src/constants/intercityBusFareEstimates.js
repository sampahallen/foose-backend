const { estimateDistanceKm } = require("./ghanaCityDistances");

/**
 * Informational fare ESTIMATE for the existing bus-transit companies
 * (Intercity STC, 2M Express, VIP Jeoun), shown at checkout and used to
 * pre-fill (not replace) the seller's actual `transit.amount` entered at
 * dispatch. Never charged through the platform — same "informational only"
 * status as `transit.amount` already has.
 *
 * Calibrated against VIP Jeoun's published April-2026 standard-class fares
 * (the only one of the three with a reliably current public fare list):
 * Accra-Takoradi GHS120/~220km, Accra-Kumasi GHS120/~250km, Accra-Tamale
 * GHS290/~625km. A simple base+per-km line fit to the two extremes
 * (Takoradi/Tamale) gives ~GHS28 base + ~GHS0.42/km, which lands within
 * ~10% of the (non-linear, banded) real Kumasi fare too. Applied uniformly
 * to all three companies since STC/2M Express don't have an equally current
 * public rate card — treat as a planning estimate, not their actual price.
 */
const BUS_FARE_TIER = Object.freeze({
  baseFarePesewas: 2800,
  perKmPesewas: 42,
  minFeePesewas: 3000,
  maxFeePesewas: 40000,
});

/**
 * Estimated fare (pesewas) for a bus-transit leg between a shop's location
 * and a chosen destination stop (both `{ region, town }`-shaped, matching
 * the shape already used by twoMExpressRoutes.js/intercityStcRoutes.js/
 * vipJeounRoutes.js STOPS entries).
 */
function estimateBusFarePesewas(origin = {}, destination = {}) {
  const distanceKm = estimateDistanceKm({
    regionA: origin.region,
    regionB: destination.region,
    townA: origin.city || origin.town,
    townB: destination.town,
  });
  const raw = BUS_FARE_TIER.baseFarePesewas + Math.round(distanceKm * BUS_FARE_TIER.perKmPesewas);
  return Math.min(BUS_FARE_TIER.maxFeePesewas, Math.max(BUS_FARE_TIER.minFeePesewas, raw));
}

module.exports = {
  BUS_FARE_TIER,
  estimateBusFarePesewas,
};
