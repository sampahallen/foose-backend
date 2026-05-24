const crypto = require("crypto");
const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const Order = require("../models/Order");
const SearchLog = require("../models/SearchLog");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");
const { withCache } = require("../utils/cache");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOP_PICK_TAG = "top-pick";

const normalizeSearchText = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

const startOfMarketplaceWeek = () => {
  const start = new Date();
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
};

const dailyCacheStamp = () => new Date().toISOString().slice(0, 10);

const logSearchTerm = (value) => {
  const query = String(value || "").trim().replace(/\s+/g, " ");
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedQuery) return;

  SearchLog.create({ query, normalizedQuery }).catch((error) => {
    console.warn(`Search log failed: ${error.message}`);
  });
};

const queryHash = (query) => {
  const sortedQuery = Object.keys(query)
    .sort()
    .reduce((acc, key) => {
      acc[key] = query[key];
      return acc;
    }, {});

  return crypto
    .createHash("md5")
    .update(JSON.stringify(sortedQuery))
    .digest("hex");
};

const listingSearchData = async (query, baseFilter = {}) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  const filter = { status: "active", ...baseFilter };

  if (query.q) {
    const pattern = new RegExp(`\\b${escapeRegex(query.q)}`, "i");
    filter.$or = [
      { title: pattern },
      { brand: pattern },
      { category: pattern },
      { description: pattern },
    ];
  }

  ["category", "type", "condition", "gender", "size", "brand"].forEach(
    (field) => {
      if (query[field]) filter[field] = query[field];
    },
  );

  if (query.minPrice || query.maxPrice) {
    filter.price = {};
    if (query.minPrice) filter.price.$gte = Number(query.minPrice);
    if (query.maxPrice) filter.price.$lte = Number(query.maxPrice);
  }

  const sortOptions = {
    newest: { createdAt: -1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    popular: { views: -1 },
  };
  const sort = sortOptions[query.sort] || sortOptions.newest;

  const [results, total] = await Promise.all([
    Listing.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("shopId", "shopName slug rating totalReviews")
      .lean(),
    Listing.countDocuments(filter),
  ]);

  return {
    results,
    total,
    page,
    pages: Math.ceil(total / limit),
  };
};

exports.searchListings = asyncHandler(async (req, res) => {
  logSearchTerm(req.query.q);
  const cacheKey = `search:${queryHash(req.query)}`;
  const data = await withCache(cacheKey, 60, () => listingSearchData(req.query));

  return success(res, data);
});

exports.getTopPicks = asyncHandler(async (req, res) => {
  const cacheKey = `search:top-picks:${queryHash(req.query)}`;
  const data = await withCache(cacheKey, 120, () =>
    listingSearchData(req.query, { promotionTags: TOP_PICK_TAG }),
  );

  return success(res, data, "Top picks loaded");
});

exports.getFeatured = asyncHandler(async (req, res) => {
  const listings = await withCache("listings:featured", 300, () =>
    Listing.find({ status: "active" })
      .sort({ views: -1, createdAt: -1 })
      .limit(12)
      .populate("shopId", "shopName slug rating totalReviews")
      .lean(),
  );

  return success(res, { listings }, "Featured listings loaded");
});

exports.getPopularSearches = asyncHandler(async (req, res) => {
  const weekStart = startOfMarketplaceWeek();
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 25);
  const cacheKey = `search:popular:${weekStart.toISOString()}:${dailyCacheStamp()}:${limit}`;

  const searches = await withCache(cacheKey, 3600, () =>
    SearchLog.aggregate([
      { $match: { createdAt: { $gte: weekStart } } },
      {
        $group: {
          _id: "$normalizedQuery",
          count: { $sum: 1 },
          query: { $first: "$query" },
        },
      },
      { $sort: { count: -1, query: 1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          count: 1,
          normalizedQuery: "$_id",
          query: 1,
        },
      },
    ]),
  );

  return success(res, { searches, weekStart }, "Popular searches loaded");
});

exports.getTopSellers = asyncHandler(async (req, res) => {
  const weekStart = startOfMarketplaceWeek();
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 25);
  const cacheKey = `search:top-sellers:${weekStart.toISOString()}:${dailyCacheStamp()}:${limit}`;

  const sellers = await withCache(cacheKey, 3600, async () => {
    const rows = await Order.aggregate([
      { $match: { status: "delivered", updatedAt: { $gte: weekStart } } },
      {
        $group: {
          _id: "$shopId",
          completedOrders: { $sum: 1 },
          revenue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { completedOrders: -1, revenue: -1 } },
      { $limit: limit },
    ]);

    const shopIds = rows.map((row) => row._id).filter(Boolean);
    const shops = await DigiShop.find({ _id: { $in: shopIds }, isLive: true })
      .populate("ownerId", "name username profilePhoto")
      .lean();
    const shopsById = new Map(shops.map((shop) => [shop._id.toString(), shop]));

    return rows
      .map((row) => {
        const shop = row._id ? shopsById.get(row._id.toString()) : null;
        if (!shop) return null;

        return {
          ...shop,
          completedOrders: row.completedOrders,
          revenue: row.revenue,
        };
      })
      .filter(Boolean);
  });

  return success(res, { sellers, weekStart }, "Top sellers loaded");
});
