const DELIVERY_METHODS = Object.freeze([
  "station_pickup",
  "shop_pickup",
  "airport_to_airport",
  "intra_city_courier",
  "inter_city_courier",
]);

const STATION_PICKUP_COMPANIES = Object.freeze([
  "Intercity STC",
  "2M Express",
  "VIP Jeoun",
]);

const AIRPORT_COURIER = "Passion Air Courier";

// The two door-to-door courier methods (Bolt Send/Yango Delivery for
// intra-city, ShaQ Express for inter-city). They share a dispatch/tracking
// flow that's simpler than the bus/airport waybill flow, so several places
// branch on this list.
const COURIER_METHODS = Object.freeze(["intra_city_courier", "inter_city_courier"]);

module.exports = {
  AIRPORT_COURIER,
  COURIER_METHODS,
  DELIVERY_METHODS,
  STATION_PICKUP_COMPANIES,
};
