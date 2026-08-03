/**
 * Intercity STC runs a nationwide coach network, unlike the narrow fixed routes 2M
 * Express operates. Any seller near one of STC's Ghana terminals can offer station
 * pickup via STC, and the buyer can pick almost any other STC terminal as the
 * destination (excluding terminals in the seller's own town). Terminal list sourced
 * from stcgh.com/terminals; international terminals (Abidjan, Cotonou, Lome,
 * Ouagadougou) are out of scope since this app only models Ghana regions.
 */
const STOPS = Object.freeze([
  Object.freeze({ region: "Greater Accra", terminal: "Achimota", town: "Accra" }),
  Object.freeze({ region: "Greater Accra", terminal: "Circle", town: "Accra" }),
  Object.freeze({ region: "Greater Accra", terminal: "Main", town: "Accra" }),
  Object.freeze({ region: "Greater Accra", terminal: "Tudu", town: "Accra" }),
  Object.freeze({ region: "Volta", terminal: "", town: "Aflao" }),
  Object.freeze({ region: "Greater Accra", terminal: "", town: "Amasaman" }),
  Object.freeze({ region: "Greater Accra", terminal: "", town: "Ashiaman" }),
  Object.freeze({ region: "Bono", terminal: "", town: "Berekum" }),
  Object.freeze({ region: "Upper East", terminal: "", town: "Bolgatanga" }),
  Object.freeze({ region: "Eastern", terminal: "", town: "Bunso" }),
  Object.freeze({ region: "Central", terminal: "", town: "Cape Coast" }),
  Object.freeze({ region: "Savannah", terminal: "", town: "Damongo" }),
  Object.freeze({ region: "Bono", terminal: "", town: "Dormaa" }),
  Object.freeze({ region: "Western", terminal: "", town: "Elubo" }),
  Object.freeze({ region: "Volta", terminal: "", town: "Ho" }),
  Object.freeze({ region: "Volta", terminal: "", town: "Hohoe" }),
  Object.freeze({ region: "Oti", terminal: "", town: "Jasikan" }),
  Object.freeze({ region: "Oti", terminal: "", town: "Kadjebi" }),
  Object.freeze({ region: "Central", terminal: "", town: "Kasoa" }),
  Object.freeze({ region: "Bono East", terminal: "", town: "Kintampo" }),
  Object.freeze({ region: "Ashanti", terminal: "Adum", town: "Kumasi" }),
  Object.freeze({ region: "Ashanti", terminal: "Asafo", town: "Kumasi" }),
  Object.freeze({ region: "Ashanti", terminal: "Labour", town: "Kumasi" }),
  Object.freeze({ region: "Ashanti", terminal: "Oforikrom", town: "Kumasi" }),
  Object.freeze({ region: "Greater Accra", terminal: "", town: "Madina" }),
  Object.freeze({ region: "North East", terminal: "", town: "Nalerigu" }),
  Object.freeze({ region: "Upper West", terminal: "", town: "Nandom" }),
  Object.freeze({ region: "Upper East", terminal: "", town: "Navrongo" }),
  Object.freeze({ region: "Oti", terminal: "", town: "Nkwanta" }),
  Object.freeze({ region: "Upper East", terminal: "", town: "Paga" }),
  Object.freeze({ region: "Greater Accra", terminal: "", town: "Pokuasi" }),
  Object.freeze({ region: "Western", terminal: "", town: "Sekondi" }),
  Object.freeze({ region: "Bono", terminal: "", town: "Sunyani" }),
  Object.freeze({ region: "Western", terminal: "Main", town: "Takoradi" }),
  Object.freeze({ region: "Northern", terminal: "Main", town: "Tamale" }),
  Object.freeze({ region: "Western", terminal: "", town: "Tarkwa" }),
  Object.freeze({ region: "Bono East", terminal: "", town: "Techiman" }),
  Object.freeze({ region: "Greater Accra", terminal: "", town: "Tema" }),
  Object.freeze({ region: "Upper West", terminal: "", town: "Wa" }),
  Object.freeze({ region: "North East", terminal: "", town: "Walewale" }),
]);

const normalize = (value) => String(value || "").trim().toLowerCase();

const isEligibleOrigin = (origin = {}) =>
  STOPS.some((stop) => normalize(stop.town) === normalize(origin.city));

const destinationsForOrigin = (origin = {}) => {
  if (!isEligibleOrigin(origin)) return [];
  return STOPS.filter((stop) => normalize(stop.town) !== normalize(origin.city));
};

const isValidDestination = (origin, destination) =>
  destinationsForOrigin(origin).some(
    (stop) =>
      normalize(stop.region) === normalize(destination?.region) &&
      normalize(stop.town) === normalize(destination?.town),
  );

module.exports = {
  STOPS,
  destinationsForOrigin,
  isEligibleOrigin,
  isValidDestination,
};
