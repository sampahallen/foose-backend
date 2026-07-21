const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { withCache, invalidate, invalidatePattern } = require("../utils/cache");
const { normalizeHashtags } = require("../utils/hashtags");
const { hasCompleteLocation, mergeLocation } = require("../utils/location");
const { syncListingHashtags } = require("../services/hashtagService");
const {
  runSearchSync,
  syncListingSearchDocument,
} = require("../services/searchIndexService");
const { ensureShopLocationFromOwner, listingLocationClause } = require("../services/locationService");

const pageOptions = (query) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

const parseVolumeDiscounts = (value) => {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const parsePromotionTags = (value) => {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
};

const parseImageList = (value) => {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((image) => String(image).trim())
    .filter(Boolean);
};

const normalizeListingTypeFields = (input, currentListing) => {
  const type = input.type || currentListing?.type;

  if (type === "retail") {
    input.quantity = 1;
    input.bulkMinQty = undefined;
    input.bulkWeight = undefined;
    input.volumeDiscounts = [];
    return input;
  }

  if (type === "wholesale") {
    const quantity = input.quantity ?? currentListing?.quantity;
    const bulkMinQty = input.bulkMinQty ?? currentListing?.bulkMinQty;

    if (!quantity || quantity < 1) {
      throw httpError(422, "Wholesale listings require a total available quantity");
    }

    if (!bulkMinQty || bulkMinQty < 1) {
      throw httpError(422, "Wholesale listings require a minimum order quantity");
    }

    if (bulkMinQty > quantity) {
      throw httpError(422, "Minimum order quantity cannot exceed total available quantity");
    }
  }

  return input;
};

const listingInput = (req, currentListing) => {
  const input = { ...req.body };
  ["price", "quantity", "bulkMinQty"].forEach((field) => {
    if (input[field] !== undefined && input[field] !== "") {
      input[field] = Number(input[field]);
    }
  });

  const volumeDiscounts = parseVolumeDiscounts(req.body.volumeDiscounts);
  if (volumeDiscounts) input.volumeDiscounts = volumeDiscounts;
  if (req.body.hashtags !== undefined) input.hashtags = normalizeHashtags(req.body.hashtags);
  if (req.body.promotionTags !== undefined) input.promotionTags = parsePromotionTags(req.body.promotionTags);
  if (currentListing) {
    const keptImagesTouched = req.body.keptImagesTouched !== undefined;
    const keptImages = parseImageList(req.body.keptImages);

    if (keptImagesTouched || req.fileUrls?.length) {
      input.images = [...(keptImages || []), ...(req.fileUrls || [])].slice(0, 6);
    }
  } else if (req.fileUrls?.length) {
    input.images = req.fileUrls;
  }

  return normalizeListingTypeFields(input, currentListing);
};

exports.listListings = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req.query);
  const filter = { status: "active", visibility: { $ne: "event" } };

  if (req.user?.id) {
    const ownShop = await DigiShop.findOne({ ownerId: req.user.id }).select("_id").lean();
    if (ownShop) filter.shopId = { $ne: ownShop._id };
  }

  ["category", "type", "gender", "condition", "color", "size", "brand"].forEach((field) => {
    if (req.query[field]) filter[field] = req.query[field];
  });
  if (req.query.location) {
    const locationClause = await listingLocationClause(req.query.location);
    if (locationClause) filter.$and = [locationClause];
  }

  const [results, total] = await Promise.all([
    Listing.find(filter)
      .populate("shopId", "shopName slug rating totalReviews location")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Listing.countDocuments(filter),
  ]);

  return success(res, { results, total, page, pages: Math.ceil(total / limit) });
});

exports.getListing = asyncHandler(async (req, res) => {
  const listing = await withCache(`listing:${req.params.id}`, 600, () =>
    Listing.findOne({ _id: req.params.id, status: { $ne: "removed" } })
      .populate("shopId", "shopName slug rating totalReviews ownerId location")
      .lean(),
  );

  if (!listing) {
    throw httpError(404, "Listing not found");
  }

  const populatedShop = listing.shopId && typeof listing.shopId === "object"
    ? listing.shopId
    : null;
  const ownerId = populatedShop?.ownerId?._id || populatedShop?.ownerId;
  const isPublicListing = !listing.status || listing.status === "active";
  if (!isPublicListing && String(ownerId || "") !== String(req.user?.id || "")) {
    throw httpError(404, "Listing not found");
  }

  if (isPublicListing) {
    await Listing.updateOne(
      { _id: req.params.id, status: { $ne: "removed" } },
      { $inc: { views: 1 } },
    );
  }

  return success(res, { listing }, "Listing loaded");
});

exports.getListingAvailability = asyncHandler(async (req, res) => {
  const ids = req.validated.query.ids;
  const [listings, ownShop] = await Promise.all([
    Listing.find({ _id: { $in: ids } }).select("_id shopId status").lean(),
    req.user?.id ? DigiShop.findOne({ ownerId: req.user.id }).select("_id").lean() : null,
  ]);
  const storedStatuses = new Map(listings.map((listing) => [String(listing._id), listing.status]));
  const statuses = Object.fromEntries(ids.map((id) => {
    const status = storedStatuses.get(id);
    return [id, status === "active" || status === "sold" ? status : "removed"];
  }));
  const ownedListingIds = ownShop
    ? listings.filter((listing) => String(listing.shopId) === String(ownShop._id)).map((listing) => String(listing._id))
    : [];

  return success(res, { ownedListingIds, statuses }, "Listing availability loaded");
});

exports.getShopListings = asyncHandler(async (req, res) => {
  const listings = await withCache(`shop:${req.params.shopId}:listings`, 300, () =>
    Listing.find({
      shopId: req.params.shopId,
      status: "active",
      visibility: { $ne: "event" },
    })
      .populate("shopId", "shopName slug rating totalReviews location")
      .sort({ createdAt: -1 })
      .lean(),
  );

  return success(res, { listings }, "Shop listings loaded");
});

exports.getMyListings = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id });

  if (!shop) {
    throw httpError(403, "DigiShop required");
  }

  const requestedStatus = req.validated?.query?.status ?? req.query.status;
  const listings = await Listing.find({
    shopId: shop._id,
    status: requestedStatus || { $ne: "removed" },
  })
    .sort({ createdAt: -1 })
    .lean();

  return success(res, { listings }, "Seller listings loaded");
});

exports.createListing = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id });

  if (!shop) {
    throw httpError(403, "DigiShop required");
  }

  const resolvedLocation = await ensureShopLocationFromOwner(shop);
  if (!hasCompleteLocation(resolvedLocation.location)) {
    throw httpError(422, "Set both a city and region in your shop settings before posting an item");
  }

  const listing = await Listing.create({
    ...listingInput(req),
    shopId: shop._id,
    location: resolvedLocation.location,
  });

  await syncListingHashtags(null, listing);
  await runSearchSync(`listing:${listing._id}:create`, () =>
    syncListingSearchDocument(listing._id));

  await invalidate("listings:featured", `shop:${shop._id}:listings`, `shop:${shop.slug}`);
  await invalidatePattern("search:*");

  return success(res, { listing }, "Listing created", 201);
});

exports.updateListing = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id });
  const resolvedLocation = shop ? await ensureShopLocationFromOwner(shop) : null;
  const listing = await Listing.findOne({
    _id: req.params.id,
    shopId: shop?._id,
    status: { $ne: "removed" },
  });

  if (!listing) {
    throw httpError(404, "Listing not found");
  }

  const previousListing = listing.toObject();
  Object.assign(listing, listingInput(req, listing));
  if (!hasCompleteLocation(listing.location) && hasCompleteLocation(resolvedLocation?.location)) {
    listing.location = mergeLocation(listing.location, resolvedLocation.location);
  }
  await listing.save();
  await syncListingHashtags(previousListing, listing);
  await runSearchSync(`listing:${listing._id}:update`, () =>
    syncListingSearchDocument(listing._id));
  await invalidate(
    "listings:featured",
    `listing:${listing._id}`,
    `shop:${shop._id}:listings`,
  );
  await invalidatePattern("search:*");

  return success(res, { listing }, "Listing updated");
});

exports.deleteListing = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id });
  const listing = await Listing.findOne({
    _id: req.params.id,
    shopId: shop?._id,
    status: { $ne: "removed" },
  });

  if (!listing) {
    throw httpError(404, "Listing not found");
  }

  const previousListing = listing.toObject();
  listing.status = "removed";
  await listing.save();
  await syncListingHashtags(previousListing, listing);
  await runSearchSync(`listing:${listing._id}:remove`, () =>
    syncListingSearchDocument(listing._id));
  await invalidate(
    "listings:featured",
    `listing:${listing._id}`,
    `shop:${shop._id}:listings`,
  );
  await invalidatePattern("search:*");

  return success(res, { listing }, "Listing removed");
});
