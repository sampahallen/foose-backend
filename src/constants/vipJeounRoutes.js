/**
 * VIP Jeoun runs a hub-and-spoke network centered on Accra (source: vipbustickets.com/routes
 * — every listed route pairs a town with Accra in one direction or the other, with no
 * direct town-to-town routes). A seller in Accra can send to any spoke town; a seller in
 * a spoke town can only send to Accra. Duplicate service-tier listings for the same town
 * (e.g. "Dunkwa" and "Dunkwa Tour") are collapsed to one stop.
 */
const STOPS = Object.freeze([
  Object.freeze({ region: "Greater Accra", terminal: "", town: "Accra" }),
  Object.freeze({ region: "Central", terminal: "", town: "Dunkwa" }),
  Object.freeze({ region: "Western North", terminal: "", town: "Sehwi" }),
  Object.freeze({ region: "Bono", terminal: "", town: "Sunyani" }),
  Object.freeze({ region: "Ahafo", terminal: "", town: "Mim" }),
  Object.freeze({ region: "Ahafo", terminal: "", town: "Goaso" }),
  Object.freeze({ region: "Ashanti", terminal: "", town: "Kumasi" }),
  Object.freeze({ region: "Bono East", terminal: "", town: "Yeji" }),
  Object.freeze({ region: "Bono", terminal: "", town: "Wenchi" }),
  Object.freeze({ region: "Bono", terminal: "", town: "Sampa" }),
  Object.freeze({ region: "Northern", terminal: "", town: "Yendi" }),
  Object.freeze({ region: "Upper East", terminal: "", town: "Bawku" }),
  Object.freeze({ region: "Upper East", terminal: "", town: "Bolgatanga" }),
  Object.freeze({ region: "Northern", terminal: "", town: "Tamale" }),
  Object.freeze({ region: "Upper East", terminal: "", town: "Navrongo" }),
  Object.freeze({ region: "Bono East", terminal: "", town: "Kintampo" }),
  Object.freeze({ region: "Bono East", terminal: "", town: "Nkoranza" }),
  Object.freeze({ region: "Bono East", terminal: "", town: "Techiman" }),
  Object.freeze({ region: "Bono", terminal: "", town: "Dormaa" }),
  Object.freeze({ region: "Upper West", terminal: "", town: "Wa" }),
]);

const HUB_TOWN = "Accra";

const normalize = (value) => String(value || "").trim().toLowerCase();

const isEligibleOrigin = (origin = {}) =>
  STOPS.some((stop) => normalize(stop.town) === normalize(origin.city));

const destinationsForOrigin = (origin = {}) => {
  const normalizedCity = normalize(origin.city);
  if (!STOPS.some((stop) => normalize(stop.town) === normalizedCity)) return [];
  if (normalizedCity === normalize(HUB_TOWN)) {
    return STOPS.filter((stop) => normalize(stop.town) !== normalizedCity);
  }
  return STOPS.filter((stop) => normalize(stop.town) === normalize(HUB_TOWN));
};

const isValidDestination = (origin, destination) =>
  destinationsForOrigin(origin).some(
    (stop) =>
      normalize(stop.region) === normalize(destination?.region) &&
      normalize(stop.town) === normalize(destination?.town),
  );

module.exports = {
  HUB_TOWN,
  STOPS,
  destinationsForOrigin,
  isEligibleOrigin,
  isValidDestination,
};
