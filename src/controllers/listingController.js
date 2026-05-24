const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { withCache, invalidate, invalidatePattern } = require("../utils/cache");

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
  const filter = { status: "active" };

  ["category", "type", "gender", "condition", "size", "brand"].forEach((field) => {
    if (req.query[field]) filter[field] = req.query[field];
  });

  const [results, total] = await Promise.all([
    Listing.find(filter)
      .populate("shopId", "shopName slug rating totalReviews")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Listing.countDocuments(filter),
  ]);

  return success(res, { results, total, page, pages: Math.ceil(total / limit) });
});

exports.getListing = asyncHandler(async (req, res) => {
  await Listing.updateOne(
    { _id: req.params.id, status: { $ne: "removed" } },
    { $inc: { views: 1 } },
  );

  const listing = await withCache(`listing:${req.params.id}`, 600, () =>
    Listing.findOne({ _id: req.params.id, status: { $ne: "removed" } })
      .populate("shopId", "shopName slug rating totalReviews ownerId")
      .lean(),
  );

  if (!listing) {
    throw httpError(404, "Listing not found");
  }

  return success(res, { listing }, "Listing loaded");
});

exports.getShopListings = asyncHandler(async (req, res) => {
  const listings = await withCache(`shop:${req.params.shopId}:listings`, 300, () =>
    Listing.find({
      shopId: req.params.shopId,
      status: "active",
    })
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

  const listings = await Listing.find({
    shopId: shop._id,
    status: { $ne: "removed" },
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

  const listing = await Listing.create({
    ...listingInput(req),
    shopId: shop._id,
  });

  await invalidate("listings:featured", `shop:${shop._id}:listings`);
  await invalidatePattern("search:top-picks:*");

  return success(res, { listing }, "Listing created", 201);
});

exports.updateListing = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id });
  const listing = await Listing.findOne({
    _id: req.params.id,
    shopId: shop?._id,
    status: { $ne: "removed" },
  });

  if (!listing) {
    throw httpError(404, "Listing not found");
  }

  Object.assign(listing, listingInput(req, listing));
  await listing.save();
  await invalidate(
    "listings:featured",
    `listing:${listing._id}`,
    `shop:${shop._id}:listings`,
  );
  await invalidatePattern("search:top-picks:*");

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

  listing.status = "removed";
  await listing.save();
  await invalidate(
    "listings:featured",
    `listing:${listing._id}`,
    `shop:${shop._id}:listings`,
  );
  await invalidatePattern("search:top-picks:*");

  return success(res, { listing }, "Listing removed");
});
