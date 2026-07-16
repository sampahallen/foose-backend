const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const User = require("../models/User");
const {
  hasCompleteLocation,
  incompleteLocationQuery,
  mergeLocation,
  normalizeLocation,
} = require("../utils/location");

const idValue = (value) => String(value?._id || value || "");

const backfillMarketplaceLocations = async () => {
  const incompleteShops = await DigiShop.find(incompleteLocationQuery())
    .select("_id ownerId location")
    .lean();
  const ownerIds = [...new Set(incompleteShops.map((shop) => idValue(shop.ownerId)).filter(Boolean))];
  const owners = ownerIds.length
    ? await User.find({ _id: { $in: ownerIds } }).select("_id location").lean()
    : [];
  const ownersById = new Map(owners.map((owner) => [idValue(owner), owner]));
  const resolvedShopLocations = new Map();
  const shopOperations = [];

  incompleteShops.forEach((shop) => {
    const location = mergeLocation(shop.location, ownersById.get(idValue(shop.ownerId))?.location);
    if (!hasCompleteLocation(location)) return;

    resolvedShopLocations.set(idValue(shop), location);
    shopOperations.push({
      updateOne: {
        filter: { _id: shop._id, ...incompleteLocationQuery() },
        update: { $set: { location } },
      },
    });
  });

  const shopResult = shopOperations.length
    ? await DigiShop.bulkWrite(shopOperations, { ordered: false })
    : null;

  const incompleteListingShopIds = await Listing.distinct("shopId", incompleteLocationQuery());
  const listingShops = incompleteListingShopIds.length
    ? await DigiShop.find({ _id: { $in: incompleteListingShopIds } })
        .select("_id location")
        .lean()
    : [];
  const listingOperations = listingShops
    .map((shop) => ({ shop, location: normalizeLocation(shop.location) }))
    .filter(({ location }) => hasCompleteLocation(location))
    .map(({ shop, location }) => ({
      updateMany: {
        filter: { shopId: shop._id, ...incompleteLocationQuery() },
        update: { $set: { location } },
      },
    }));
  const listingResult = listingOperations.length
    ? await Listing.bulkWrite(listingOperations, { ordered: false })
    : null;

  return {
    listingsUpdated: listingResult?.modifiedCount || 0,
    shopsUpdated: shopResult?.modifiedCount || 0,
    unresolvedShops: incompleteShops.length - resolvedShopLocations.size,
  };
};

module.exports = {
  backfillMarketplaceLocations,
};
