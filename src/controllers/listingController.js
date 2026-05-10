const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");

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

const listingInput = (req) => {
  const input = { ...req.body };
  ["price", "quantity", "bulkMinQty"].forEach((field) => {
    if (input[field] !== undefined && input[field] !== "") {
      input[field] = Number(input[field]);
    }
  });

  const volumeDiscounts = parseVolumeDiscounts(req.body.volumeDiscounts);
  if (volumeDiscounts) input.volumeDiscounts = volumeDiscounts;
  if (req.fileUrls?.length) input.images = req.fileUrls;

  return input;
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
  const listing = await Listing.findOneAndUpdate(
    { _id: req.params.id, status: { $ne: "removed" } },
    { $inc: { views: 1 } },
    { new: true },
  ).populate("shopId", "shopName slug rating totalReviews ownerId");

  if (!listing) {
    throw httpError(404, "Listing not found");
  }

  return success(res, { listing }, "Listing loaded");
});

exports.getShopListings = asyncHandler(async (req, res) => {
  const listings = await Listing.find({
    shopId: req.params.shopId,
    status: "active",
  }).sort({ createdAt: -1 });

  return success(res, { listings }, "Shop listings loaded");
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

  Object.assign(listing, listingInput(req));
  await listing.save();

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

  return success(res, { listing }, "Listing removed");
});
