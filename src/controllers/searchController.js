const Listing = require("../models/Listing");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");

exports.searchListings = asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const filter = { status: "active" };

  if (req.query.q) filter.$text = { $search: req.query.q };

  ["category", "type", "condition", "gender", "size", "brand"].forEach((field) => {
    if (req.query[field]) filter[field] = req.query[field];
  });

  if (req.query.minPrice || req.query.maxPrice) {
    filter.price = {};
    if (req.query.minPrice) filter.price.$gte = Number(req.query.minPrice);
    if (req.query.maxPrice) filter.price.$lte = Number(req.query.maxPrice);
  }

  const sortOptions = {
    newest: { createdAt: -1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    popular: { views: -1 },
  };
  const sort = sortOptions[req.query.sort] || sortOptions.newest;

  const [results, total] = await Promise.all([
    Listing.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("shopId", "shopName slug rating totalReviews"),
    Listing.countDocuments(filter),
  ]);

  return success(res, {
    results,
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});
