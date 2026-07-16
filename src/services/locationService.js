const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const User = require("../models/User");
const {
  hasCompleteLocation,
  incompleteLocationQuery,
  locationMatchQuery,
  mergeLocation,
  normalizeLocation,
} = require("../utils/location");

const sameLocation = (left, right) => {
  const first = normalizeLocation(left);
  const second = normalizeLocation(right);
  return first.city === second.city && first.region === second.region;
};

const fillIncompleteListingLocations = async (shopId, location, ListingModel = Listing) => {
  const normalizedLocation = normalizeLocation(location);
  if (!shopId || !hasCompleteLocation(normalizedLocation)) return 0;

  const result = await ListingModel.updateMany(
    { shopId, ...incompleteLocationQuery() },
    { $set: { location: normalizedLocation } },
  );

  return result.modifiedCount || 0;
};

const ensureShopLocationFromOwner = async (shop, owner = null, ListingModel = Listing) => {
  const currentLocation = normalizeLocation(shop?.location);
  if (!shop || hasCompleteLocation(currentLocation)) {
    return { changed: false, listingsUpdated: 0, location: currentLocation };
  }

  const resolvedOwner = owner || await User.findById(shop.ownerId).select("location");
  const location = mergeLocation(currentLocation, resolvedOwner?.location);
  const changed = hasCompleteLocation(location) && !sameLocation(currentLocation, location);

  if (changed) {
    shop.location = location;
    await shop.save();
  }

  const listingsUpdated = changed
    ? await fillIncompleteListingLocations(shop._id, location, ListingModel)
    : 0;

  return { changed, listingsUpdated, location };
};

const matchingLegacyShopIds = async (value) => {
  const locationClause = locationMatchQuery(value);
  if (!locationClause) return [];

  const shops = await DigiShop.find({
    isLive: true,
    ...locationClause,
  })
    .select("_id")
    .lean();

  return shops.map((shop) => shop._id);
};

const listingLocationClause = async (value) => {
  const directLocationClause = locationMatchQuery(value);
  if (!directLocationClause) return null;

  const legacyShopIds = await matchingLegacyShopIds(value);
  if (!legacyShopIds.length) return directLocationClause;

  return {
    $or: [
      directLocationClause,
      {
        $and: [
          incompleteLocationQuery(),
          { shopId: { $in: legacyShopIds } },
        ],
      },
    ],
  };
};

module.exports = {
  ensureShopLocationFromOwner,
  fillIncompleteListingLocations,
  listingLocationClause,
  matchingLegacyShopIds,
};
