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
const { closeBargainsForListing } = require("../services/bargainService");
const {
  applyCategoryFilter,
  isSupportedCategory,
  normalizeCategoryFields,
  normalizeCategorySelection,
  parseAttributes,
} = require("../utils/listingTaxonomy");

const pageOptions = (query) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MY_LISTINGS_SEARCH_FIELDS = ["title", "brand", "category", "subcategory", "size", "gender", "color"];

const parseVolumeDiscounts = (value) => {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
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

  // A listing - retail or wholesale - is sold as a single unit. A bale is one
  // bundle, not a bulk SKU with its own stock count, so there is no more
  // per-listing quantity or minimum order quantity to collect.
  input.quantity = 1;
  input.bulkMinQty = undefined;

  if (type === "retail") {
    input.bulkWeight = undefined;
    input.volumeDiscounts = [];
    return input;
  }

  if (type === "wholesale") {
    const bulkWeight = input.bulkWeight ?? currentListing?.bulkWeight;
    if (!bulkWeight || !String(bulkWeight).trim()) {
      throw httpError(422, "Wholesale listings require a weight");
    }

    const baleGrade = input.attributes?.baleGrade ?? currentListing?.attributes?.baleGrade;
    if (!baleGrade) {
      throw httpError(422, "Wholesale listings require a bale grade");
    }

    // Tiered bulk pricing no longer applies now that every bale is one unit.
    input.volumeDiscounts = [];
  }

  return input;
};

const normalizeBargainFields = (input, currentListing) => {
  const bargainingAllowed = input.bargainingAllowed ?? currentListing?.bargainingAllowed ?? false;

  if (!bargainingAllowed) {
    // No point keeping a floor on a listing nobody can haggle over.
    input.minAcceptablePrice = undefined;
    return input;
  }

  const minimum = input.minAcceptablePrice ?? currentListing?.minAcceptablePrice;
  if (minimum === undefined || minimum === null || minimum === 0) {
    if (input.minAcceptablePrice === 0) input.minAcceptablePrice = undefined;
    return input;
  }

  const price = input.price ?? currentListing?.price;
  if (price !== undefined && Number(minimum) > Number(price)) {
    throw httpError(422, "The lowest price you will accept cannot be above the listed price");
  }

  return input;
};

const listingInput = (req, currentListing) => {
  const input = { ...req.body };
  delete input.promotionTags;
  delete input.promotionExpiresAt;
  delete input.promotionReferences;
  ["price", "quantity", "bulkMinQty", "minAcceptablePrice"].forEach((field) => {
    if (input[field] !== undefined && input[field] !== "") {
      input[field] = Number(input[field]);
    }
  });

  const volumeDiscounts = parseVolumeDiscounts(req.body.volumeDiscounts);
  if (volumeDiscounts) input.volumeDiscounts = volumeDiscounts;
  if (req.body.hashtags !== undefined) input.hashtags = normalizeHashtags(req.body.hashtags);
  if (req.body.attributes !== undefined) {
    try {
      input.attributes = parseAttributes(req.body.attributes);
    } catch (error) {
      throw httpError(422, error.message);
    }
  }
  if (currentListing) {
    const keptImagesTouched = req.body.keptImagesTouched !== undefined;
    const keptImages = parseImageList(req.body.keptImages);

    if (keptImagesTouched || req.fileUrls?.length) {
      input.images = [...(keptImages || []), ...(req.fileUrls || [])].slice(0, 6);
    }
  } else if (req.fileUrls?.length) {
    input.images = req.fileUrls;
  }

  normalizeListingTypeFields(input, currentListing);
  normalizeBargainFields(input, currentListing);

  const rawCategory = String(input.category ?? currentListing?.category ?? "").trim();
  const rawSubcategory = String(
    input.subcategory ?? (input.category !== undefined ? "" : currentListing?.subcategory) ?? "",
  ).trim();
  const selection = normalizeCategorySelection(rawCategory, rawSubcategory);
  const status = input.status || currentListing?.status || "active";
  if (rawCategory && !selection.validCategory) {
    throw httpError(422, "Choose a supported listing category");
  }
  if (rawSubcategory && !selection.validSubcategory) {
    throw httpError(422, "Choose a subcategory that belongs to the selected category");
  }
  if (status === "active" && !isSupportedCategory(selection.category)) {
    throw httpError(422, "Choose a supported category before publishing this listing");
  }

  if (selection.validCategory) {
    input.category = selection.category;
    input.subcategory = selection.subcategory || undefined;
  }
  if (selection.legacyHashtag) {
    input.hashtags = normalizeHashtags([
      ...(input.hashtags || currentListing?.hashtags || []),
      selection.legacyHashtag,
    ]);
  }

  const taxonomyChanged =
    input.category !== undefined ||
    input.subcategory !== undefined ||
    input.type !== undefined;
  if (taxonomyChanged && input.attributes === undefined) {
    input.attributes = currentListing?.attributes?.toObject?.() || currentListing?.attributes || {};
  }

  try {
    normalizeCategoryFields(input, selection.category, {
      replaceAttributes: req.body.attributes !== undefined || taxonomyChanged,
      subcategory: selection.subcategory,
      type: input.type || currentListing?.type,
    });
  } catch (error) {
    throw httpError(422, error.message);
  }
  return input;
};

exports.listListings = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req.query);
  const filter = { status: "active", visibility: { $ne: "event" } };

  if (req.user?.id) {
    const ownShop = await DigiShop.findOne({ ownerId: req.user.id }).select("_id").lean();
    if (ownShop) filter.shopId = { $ne: ownShop._id };
  }

  applyCategoryFilter(filter, req.query.category, req.query.subcategory);
  ["type", "gender", "condition", "color", "size", "brand"].forEach((field) => {
    if (req.query[field]) filter[field] = req.query[field];
  });
  ["material", "fit", "pattern", "baleGrade"].forEach((field) => {
    if (req.query[field]) filter[`attributes.${field}`] = req.query[field];
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

  const q = req.validated?.query ?? req.query;
  const { page, limit, skip } = pageOptions(req.query);

  const filter = {
    shopId: shop._id,
    status: q.status || { $ne: "removed" },
  };
  if (q.type) filter.type = q.type;
  if (q.search) {
    const pattern = new RegExp(escapeRegex(q.search), "i");
    filter.$or = MY_LISTINGS_SEARCH_FIELDS.map((field) => ({ [field]: pattern }));
  }
  if (q.dateFrom || q.dateTo) {
    filter.createdAt = {};
    if (q.dateFrom) filter.createdAt.$gte = new Date(`${q.dateFrom}T00:00:00.000Z`);
    if (q.dateTo) filter.createdAt.$lte = new Date(`${q.dateTo}T23:59:59.999Z`);
  }

  const [listings, total] = await Promise.all([
    // The seller owns these rows, so their private bargaining floor comes back
    // with them for the edit form.
    Listing.find(filter)
      .select("+minAcceptablePrice")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Listing.countDocuments(filter),
  ]);

  return success(res, {
    listings,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
  }, "Seller listings loaded");
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
  }).select("+minAcceptablePrice");

  if (!listing) {
    throw httpError(404, "Listing not found");
  }

  const previousListing = listing.toObject();
  Object.assign(listing, listingInput(req, listing));
  if (!hasCompleteLocation(listing.location) && hasCompleteLocation(resolvedLocation?.location)) {
    listing.location = mergeLocation(listing.location, resolvedLocation.location);
  }
  await listing.save();
  // A listing that leaves the marketplace cannot honour an agreed price, so any
  // live negotiation on it is closed out with a card in the thread.
  if (previousListing.status === "active" && listing.status !== "active") {
    await closeBargainsForListing({
      listingId: listing._id,
      reason: "listing_unavailable",
    });
  }
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
  await closeBargainsForListing({
    listingId: listing._id,
    reason: "listing_unavailable",
  });
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

exports.normalizeListingTypeFields = normalizeListingTypeFields;
