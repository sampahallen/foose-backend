/**
 * Road-distance data backing door-to-door courier pricing (Bolt Send / Yango
 * Delivery / ShaQ Express — see src/services/deliveryPricingService.js).
 *
 * HUB_COORDINATES gives one representative lat/lng per major town (mostly
 * regional/district capitals). DISTANCE_MATRIX is a curated set of
 * approximate road-km for the routes buyers pick most (regional-capital to
 * regional-capital, plus a few high-traffic secondary hubs). Accra-Kumasi
 * (~250km), Accra-Takoradi (~220km), Accra-Cape Coast (~145km),
 * Accra-Tamale (~625km) and Kumasi-Tamale (~381km) are cross-checked against
 * public road-distance lookups (Aug 2026); every other pair is estimated
 * from Ghana's known trunk-road layout (N1/N4/N6/N8/N10) and is a rough
 * planning figure, not a routed distance.
 *
 * For any route not in the matrix, estimateDistanceKm() falls back to a
 * great-circle (haversine) distance between the two towns' coordinates —
 * or their region's hub coordinate, if the town itself isn't in
 * HUB_COORDINATES — scaled up by ROAD_DISTANCE_FACTOR to approximate real
 * road distance. Replace this whole file with a live routing API (Google
 * Distance Matrix, OSRM, Mapbox Directions) before relying on it for real
 * logistics pricing; it exists so checkout can show a plausible, responsive
 * price with zero external dependencies.
 */

const HUB_COORDINATES = Object.freeze({
  Accra: Object.freeze({ lat: 5.6037, lng: -0.187, region: "Greater Accra" }),
  "Ada Foah": Object.freeze({ lat: 5.7833, lng: 0.6333, region: "Greater Accra" }),
  Bolgatanga: Object.freeze({ lat: 10.7856, lng: -0.8514, region: "Upper East" }),
  "Cape Coast": Object.freeze({ lat: 5.1054, lng: -1.2466, region: "Central" }),
  Damongo: Object.freeze({ lat: 9.0833, lng: -1.8167, region: "Savannah" }),
  Dambai: Object.freeze({ lat: 8.0667, lng: 0.1833, region: "Oti" }),
  Goaso: Object.freeze({ lat: 6.8017, lng: -2.5225, region: "Ahafo" }),
  Ho: Object.freeze({ lat: 6.611, lng: 0.4713, region: "Volta" }),
  Hohoe: Object.freeze({ lat: 7.1519, lng: 0.4712, region: "Volta" }),
  Kasoa: Object.freeze({ lat: 5.532, lng: -0.4165, region: "Central" }),
  Koforidua: Object.freeze({ lat: 6.094, lng: -0.2591, region: "Eastern" }),
  Kumasi: Object.freeze({ lat: 6.6885, lng: -1.6244, region: "Ashanti" }),
  Nalerigu: Object.freeze({ lat: 10.5167, lng: -0.3667, region: "North East" }),
  Nkawkaw: Object.freeze({ lat: 6.5514, lng: -0.7674, region: "Eastern" }),
  Obuasi: Object.freeze({ lat: 6.2025, lng: -1.6708, region: "Ashanti" }),
  "Sefwi Wiawso": Object.freeze({ lat: 6.2033, lng: -2.4856, region: "Western North" }),
  Sekondi: Object.freeze({ lat: 4.9346, lng: -1.7073, region: "Western" }),
  Sunyani: Object.freeze({ lat: 7.3399, lng: -2.3268, region: "Bono" }),
  Takoradi: Object.freeze({ lat: 4.8845, lng: -1.7554, region: "Western" }),
  Tamale: Object.freeze({ lat: 9.4034, lng: -0.8424, region: "Northern" }),
  Techiman: Object.freeze({ lat: 7.5911, lng: -1.9395, region: "Bono East" }),
  Tema: Object.freeze({ lat: 5.6698, lng: -0.0166, region: "Greater Accra" }),
  Wa: Object.freeze({ lat: 10.0601, lng: -2.5099, region: "Upper West" }),
  Winneba: Object.freeze({ lat: 5.3511, lng: -0.6231, region: "Central" }),
  Yendi: Object.freeze({ lat: 9.4427, lng: -0.0093, region: "Northern" }),
});

/** Region -> its primary hub in HUB_COORDINATES, for towns that aren't hubs themselves. */
const REGION_HUB_TOWN = Object.freeze({
  Ahafo: "Goaso",
  Ashanti: "Kumasi",
  Bono: "Sunyani",
  "Bono East": "Techiman",
  Central: "Cape Coast",
  Eastern: "Koforidua",
  "Greater Accra": "Accra",
  "North East": "Nalerigu",
  Northern: "Tamale",
  Oti: "Dambai",
  Savannah: "Damongo",
  "Upper East": "Bolgatanga",
  "Upper West": "Wa",
  Volta: "Ho",
  Western: "Takoradi",
  "Western North": "Sefwi Wiawso",
});

/** Approximate road-km, keyed by "TownA|TownB" with TownA/TownB alphabetically sorted. */
const DISTANCE_MATRIX = Object.freeze({
  "Accra|Bolgatanga": 785,
  "Accra|Cape Coast": 145,
  "Accra|Damongo": 590,
  "Accra|Dambai": 260,
  "Accra|Goaso": 420,
  "Accra|Ho": 165,
  "Accra|Hohoe": 215,
  "Accra|Kasoa": 32,
  "Accra|Koforidua": 85,
  "Accra|Kumasi": 250,
  "Accra|Nalerigu": 700,
  "Accra|Nkawkaw": 175,
  "Accra|Obuasi": 300,
  "Accra|Sefwi Wiawso": 340,
  "Accra|Sekondi": 230,
  "Accra|Sunyani": 375,
  "Accra|Takoradi": 220,
  "Accra|Tamale": 625,
  "Accra|Techiman": 345,
  "Accra|Tema": 30,
  "Accra|Wa": 750,
  "Accra|Winneba": 110,
  "Accra|Yendi": 720,
  "Bolgatanga|Nalerigu": 100,
  "Bolgatanga|Tamale": 160,
  "Bolgatanga|Wa": 165,
  "Cape Coast|Kasoa": 115,
  "Cape Coast|Sekondi": 100,
  "Cape Coast|Takoradi": 90,
  "Cape Coast|Winneba": 60,
  "Damongo|Tamale": 140,
  "Damongo|Wa": 220,
  "Goaso|Kumasi": 150,
  "Goaso|Sunyani": 75,
  "Goaso|Takoradi": 280,
  "Ho|Hohoe": 50,
  "Ho|Koforidua": 130,
  "Ho|Dambai": 150,
  "Koforidua|Nkawkaw": 60,
  "Kasoa|Koforidua": 130,
  "Kumasi|Cape Coast": 230,
  "Kumasi|Goaso": 150,
  "Kumasi|Ho": 280,
  "Kumasi|Hohoe": 330,
  "Kumasi|Koforidua": 180,
  "Kumasi|Obuasi": 65,
  "Kumasi|Sefwi Wiawso": 210,
  "Kumasi|Sunyani": 130,
  "Kumasi|Takoradi": 230,
  "Kumasi|Tamale": 381,
  "Kumasi|Techiman": 120,
  "Kumasi|Wa": 460,
  "Kumasi|Bolgatanga": 540,
  "Kumasi|Damongo": 350,
  "Sefwi Wiawso|Takoradi": 180,
  "Sekondi|Takoradi": 15,
  "Sunyani|Techiman": 65,
  "Tamale|Techiman": 265,
  "Tamale|Wa": 180,
  "Tamale|Yendi": 100,
  "Sunyani|Tamale": 350,
});

/** Ghana's road network winds roughly 30-40% longer than a straight line; 1.35x is a reasonable planning multiplier. */
const ROAD_DISTANCE_FACTOR = 1.35;

/** Shortest distance we'll ever quote — covers "same neighbourhood, different address" hops. */
const MIN_HOP_KM = 4;

/** Used only if a region is somehow missing a hub coordinate; should never trigger with the 16 regions above. */
const DEFAULT_UNKNOWN_ROUTE_KM = 60;

const normalizeTown = (value) => String(value || "").trim();

function matrixKey(townA, townB) {
  return [normalizeTown(townA), normalizeTown(townB)].sort((a, b) => a.localeCompare(b)).join("|");
}

function matrixDistanceKm(townA, townB) {
  return DISTANCE_MATRIX[matrixKey(townA, townB)];
}

function coordinatesForTown(town, region) {
  const direct = HUB_COORDINATES[normalizeTown(town)];
  if (direct) return direct;
  const hubTown = REGION_HUB_TOWN[region];
  return hubTown ? HUB_COORDINATES[hubTown] : undefined;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in km between two {lat, lng} points. */
function haversineKm(a, b) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

/**
 * Best-effort road distance (km) between two towns. Tries, in order:
 * 1. Same town on both ends -> MIN_HOP_KM.
 * 2. A curated DISTANCE_MATRIX entry (either direction).
 * 3. Haversine between known/region-hub coordinates x ROAD_DISTANCE_FACTOR.
 * 4. DEFAULT_UNKNOWN_ROUTE_KM, if coordinates can't be resolved at all.
 */
function estimateDistanceKm({ townA, regionA, townB, regionB } = {}) {
  const normA = normalizeTown(townA);
  const normB = normalizeTown(townB);
  if (normA && normB && normA.toLowerCase() === normB.toLowerCase()) return MIN_HOP_KM;

  const matrixHit = matrixDistanceKm(normA, normB);
  if (matrixHit !== undefined) return matrixHit;

  const coordA = coordinatesForTown(normA, regionA);
  const coordB = coordinatesForTown(normB, regionB);
  if (!coordA || !coordB) return DEFAULT_UNKNOWN_ROUTE_KM;
  if (coordA === coordB) return regionA === regionB ? MIN_HOP_KM : DEFAULT_UNKNOWN_ROUTE_KM;

  return Math.round(haversineKm(coordA, coordB) * ROAD_DISTANCE_FACTOR);
}

module.exports = {
  DISTANCE_MATRIX,
  HUB_COORDINATES,
  REGION_HUB_TOWN,
  coordinatesForTown,
  estimateDistanceKm,
  haversineKm,
  matrixDistanceKm,
};
