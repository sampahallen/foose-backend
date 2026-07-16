const crypto = require("crypto");
const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const Order = require("../models/Order");
const SearchLog = require("../models/SearchLog");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");
const { withCache } = require("../utils/cache");
const { appendQueryClause, incompleteLocationQuery, locationLabel } = require("../utils/location");
const { listingLocationClause } = require("../services/locationService");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOP_PICK_TAG = "top-pick";

const normalizeSearchText = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
const SHOP_LISTING_FIELDS = "shopName slug rating totalReviews ownerId location";

const listingLocationOptions = async (filter) => {
  const legacyFilter = { ...filter };
  if (filter.$and) legacyFilter.$and = [...filter.$and];
  appendQueryClause(legacyFilter, incompleteLocationQuery());

  const [snapshotLocations, legacyShopIds] = await Promise.all([
    Listing.aggregate([
      { $match: filter },
      {
        $match: {
          "location.city": { $exists: true, $ne: "" },
          "location.region": { $exists: true, $ne: "" },
        },
      },
      {
        $group: {
          _id: {
            city: "$location.city",
            region: "$location.region",
          },
        },
      },
    ]),
    Listing.distinct("shopId", legacyFilter),
  ]);

  const legacyShops = legacyShopIds.length
    ? await DigiShop.find({ _id: { $in: legacyShopIds }, isLive: true })
        .select("location")
        .lean()
    : [];

  const optionsByValue = new Map();

  [...snapshotLocations.map((row) => row._id), ...legacyShops.map((shop) => shop.location)]
    .forEach((location) => {
      const label = locationLabel(location);

      if (label) {
        optionsByValue.set(normalizeSearchText(label), { label, value: label });
      }
    });

  return Array.from(optionsByValue.values())
    .sort((first, second) => first.label.localeCompare(second.label));
};

const startOfMarketplaceWeek = (value = new Date()) => {
  const start = new Date(value);
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
  const filter = { status: "active", visibility: { $ne: "event" }, ...baseFilter };

  if (query.q) {
    const queryText = String(query.q).trim().replace(/^#+/, "");
    const pattern = new RegExp(`\\b${escapeRegex(queryText)}`, "i");
    filter.$or = [
      { title: pattern },
      { brand: pattern },
      { category: pattern },
      { description: pattern },
      { hashtags: pattern },
    ];
  }

  ["category", "type", "condition", "color", "gender", "size", "brand"].forEach(
    (field) => {
      if (query[field]) filter[field] = query[field];
    },
  );

  if (query.minPrice || query.maxPrice) {
    filter.price = {};
    if (query.minPrice) filter.price.$gte = Number(query.minPrice);
    if (query.maxPrice) filter.price.$lte = Number(query.maxPrice);
  }

  const locationOptionsFilter = { ...filter };
  if (filter.$and) locationOptionsFilter.$and = [...filter.$and];
  if (query.location) {
    appendQueryClause(filter, await listingLocationClause(query.location));
  }

  const sortOptions = {
    newest: { createdAt: -1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    popular: { views: -1 },
  };
  const sort = sortOptions[query.sort] || sortOptions.newest;

  const [results, total, locations] = await Promise.all([
    Listing.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("shopId", SHOP_LISTING_FIELDS)
      .lean(),
    Listing.countDocuments(filter),
    listingLocationOptions(locationOptionsFilter),
  ]);

  return {
    results,
    total,
    page,
    pages: Math.ceil(total / limit),
    filters: {
      locations,
    },
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
  const now = new Date();
  const data = await withCache(cacheKey, 120, () =>
    listingSearchData(req.query, { promotionTags: TOP_PICK_TAG, promotionExpiresAt: { $gte: now } }),
  );

  return success(res, data, "Top picks loaded");
});

exports.getFeatured = asyncHandler(async (req, res) => {
  const listings = await withCache("listings:featured", 300, () =>
    Listing.find({ status: "active", visibility: { $ne: "event" } })
      .sort({ views: -1, createdAt: -1 })
      .limit(12)
      .populate("shopId", SHOP_LISTING_FIELDS)
      .lean(),
  );

  return success(res, { listings }, "Featured listings loaded");
});

exports.getPopularSearches = asyncHandler(async (req, res) => {
  const weekStart = startOfMarketplaceWeek();
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 25);
  const cacheKey = `search:popular:${weekStart.toISOString()}:${dailyCacheStamp()}:${limit}`;

  const data = await withCache(cacheKey, 3600, async () => {
    const searchRowsForWeek = (start) => SearchLog.aggregate([
      { $match: { createdAt: { $gte: start } } },
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
    ]);

    let sourceWeekStart = weekStart;
    let searches = await searchRowsForWeek(sourceWeekStart);

    if (!searches.length) {
      const latestSearch = await SearchLog.findOne().sort({ createdAt: -1 }).lean();
      if (latestSearch?.createdAt) {
        sourceWeekStart = startOfMarketplaceWeek(latestSearch.createdAt);
        searches = await searchRowsForWeek(sourceWeekStart);
      }
    }

    return {
      searches,
      weekStart: sourceWeekStart,
      fallback: sourceWeekStart.getTime() !== weekStart.getTime(),
    };
  });

  return success(res, data, "Popular searches loaded");
});

exports.getTopSellers = asyncHandler(async (req, res) => {
  const weekStart = startOfMarketplaceWeek();
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 25);
  const cacheKey = `search:top-sellers:${weekStart.toISOString()}:${dailyCacheStamp()}:${limit}`;

  const data = await withCache(cacheKey, 3600, async () => {
    const sellersForWeek = async (start) => {
      const rows = await Order.aggregate([
        { $match: { status: "delivered", updatedAt: { $gte: start } } },
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
    };

    let sourceWeekStart = weekStart;
    let sellers = await sellersForWeek(sourceWeekStart);

    if (!sellers.length) {
      const latestOrder = await Order.findOne({ status: "delivered" }).sort({ updatedAt: -1 }).lean();
      if (latestOrder?.updatedAt) {
        sourceWeekStart = startOfMarketplaceWeek(latestOrder.updatedAt);
        sellers = await sellersForWeek(sourceWeekStart);
      }
    }

    return {
      sellers,
      weekStart: sourceWeekStart,
      fallback: sourceWeekStart.getTime() !== weekStart.getTime(),
    };
  });

  return success(res, data, "Top sellers loaded");
});
