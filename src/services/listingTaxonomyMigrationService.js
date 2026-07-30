const Listing = require("../models/Listing");
const { normalizeHashtags } = require("../utils/hashtags");
const {
  LEGACY_CATEGORY_MAP,
  LEGACY_CATEGORY_HASHTAGS,
} = require("../utils/listingTaxonomy");

const legacyListingUpdate = (listing) => {
  const legacyCategory = String(listing?.category || "").trim();
  const mapped = LEGACY_CATEGORY_MAP[legacyCategory];
  if (!mapped) return null;

  const update = {
    category: mapped[0],
    subcategory: mapped[1] || undefined,
  };
  const legacyHashtag = LEGACY_CATEGORY_HASHTAGS[legacyCategory];
  if (legacyHashtag) {
    update.hashtags = normalizeHashtags([...(listing.hashtags || []), legacyHashtag]);
  }
  if (legacyCategory === "Kids" && !listing.gender) update.gender = "kids";
  return update;
};

const migrateListingTaxonomy = async () => {
  const legacyCategories = Object.keys(LEGACY_CATEGORY_MAP);
  const listings = await Listing.find({ category: { $in: legacyCategories } })
    .select("_id category subcategory gender hashtags")
    .lean();

  if (!listings.length) return { matched: 0, updated: 0 };

  const result = await Listing.bulkWrite(listings.map((listing) => {
    const update = legacyListingUpdate(listing);
    const $unset = update.subcategory ? {} : { subcategory: "" };
    if (!update.subcategory) delete update.subcategory;
    return {
      updateOne: {
        filter: { _id: listing._id, category: listing.category },
        update: { $set: update, ...(Object.keys($unset).length ? { $unset } : {}) },
      },
    };
  }));

  return {
    matched: result.matchedCount || 0,
    updated: result.modifiedCount || 0,
  };
};

module.exports = { legacyListingUpdate, migrateListingTaxonomy };
