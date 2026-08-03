/**
 * 2M Express only operates fixed routes out of a handful of origin towns. Each origin
 * maps to the destination stops it can send parcels to; buyers pick from that fixed
 * list instead of free-typing a destination, and the seller's shop location determines
 * which (if any) origin applies.
 */
const STOPS = Object.freeze({
  ACCRA_CIRCLE: Object.freeze({ region: "Greater Accra", terminal: "Circle", town: "Accra" }),
  KUMASI_ASAFO: Object.freeze({ region: "Ashanti", terminal: "Asafo", town: "Kumasi" }),
  TAKORADI: Object.freeze({ region: "Western", terminal: "", town: "Takoradi" }),
});

const ROUTES = Object.freeze([
  Object.freeze({
    destinations: Object.freeze([STOPS.KUMASI_ASAFO, STOPS.TAKORADI]),
    origin: Object.freeze({ region: "Greater Accra" }),
  }),
  Object.freeze({
    destinations: Object.freeze([STOPS.KUMASI_ASAFO]),
    origin: Object.freeze({ city: "Kasoa", region: "Central" }),
  }),
  Object.freeze({
    destinations: Object.freeze([STOPS.ACCRA_CIRCLE]),
    origin: Object.freeze({ city: "Kumasi", region: "Ashanti" }),
  }),
]);

const normalize = (value) => String(value || "").trim().toLowerCase();

const destinationsForOrigin = ({ city, region } = {}) => {
  const route = ROUTES.find(
    (candidate) =>
      normalize(candidate.origin.region) === normalize(region) &&
      (!candidate.origin.city || normalize(candidate.origin.city) === normalize(city)),
  );
  return route ? route.destinations : [];
};

const isEligibleOrigin = (origin) => destinationsForOrigin(origin).length > 0;

const isValidDestination = (origin, destination) =>
  destinationsForOrigin(origin).some(
    (stop) =>
      normalize(stop.region) === normalize(destination?.region) &&
      normalize(stop.town) === normalize(destination?.town),
  );

module.exports = {
  ROUTES,
  STOPS,
  destinationsForOrigin,
  isEligibleOrigin,
  isValidDestination,
};
