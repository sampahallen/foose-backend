const DigiShop = require("../models/DigiShop");
const KYC = require("../models/KYC");
const Listing = require("../models/Listing");
const Order = require("../models/Order");
const SiteAnalyticsEvent = require("../models/SiteAnalyticsEvent");
const User = require("../models/User");
const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { ROLE_KEYS, USER_ROLES, roleCodeForKey, rolePath } = require("../constants/roles");
const {
  sendKycApprovedEmail,
  sendKycRejectedEmail,
} = require("../services/emailService");
const { createNotification } = require("../services/notificationService");
const { syncListingHashtags } = require("../services/hashtagService");
const {
  runSearchSync,
  syncListingSearchDocument,
} = require("../services/searchIndexService");

const APPROVED_KYC_ID_TYPES = ["Ghana Card", "Passport", "Driving License"];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function analyticsSince(days) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setUTCHours(0, 0, 0, 0);
  return since;
}

function dashboardSince(days) {
  const since = new Date();
  since.setDate(since.getDate() - days + 1);
  since.setUTCHours(0, 0, 0, 0);
  return since;
}

function fillDailyTrend(rows, days, valueKeys) {
  const buckets = new Map(rows.map((row) => [row._id, row]));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (days - index - 1));
    date.setUTCHours(0, 0, 0, 0);
    const key = date.toISOString().slice(0, 10);
    const row = buckets.get(key);
    return valueKeys.reduce(
      (point, valueKey) => ({
        ...point,
        [valueKey]: row?.[valueKey] || 0,
      }),
      { date: key },
    );
  });
}

function normalizeBucket(rows, key, fallback = "Unknown") {
  return rows.map((row) => ({
    count: row.count,
    [key]: row._id || fallback,
  }));
}

exports.stats = asyncHandler(async (req, res) => {
  const trendDays = 14;
  const since = dashboardSince(trendDays);

  const [
    users,
    shops,
    orders,
    listings,
    pendingKyc,
    pendingOrders,
    disputes,
    revenue,
    userStatus,
    userVerification,
    userTrend,
    shopCategory,
    shopLive,
    shopTrend,
    listingStatus,
    listingType,
    listingTrend,
    kycStatus,
    pendingKycByIdType,
    orderStatus,
    orderTrend,
    revenueTrend,
    disputeTrend,
    disputeEscrow,
  ] = await Promise.all([
    User.countDocuments(),
    DigiShop.countDocuments(),
    Order.countDocuments(),
    Listing.countDocuments({ status: "active" }),
    KYC.countDocuments({ status: "pending" }),
    Order.countDocuments({ status: "pending" }),
    Order.countDocuments({ status: "disputed" }),
    Order.aggregate([
      { $match: { status: "delivered" } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    User.aggregate([{ $group: { _id: "$accountStatus", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    User.aggregate([{ $group: { _id: "$isEmailVerified", count: { $sum: 1 } } }]),
    User.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }, users: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    DigiShop.aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    DigiShop.aggregate([{ $group: { _id: "$isLive", count: { $sum: 1 } } }]),
    DigiShop.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }, shops: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Listing.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Listing.aggregate([{ $group: { _id: "$type", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Listing.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }, listings: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    KYC.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    KYC.aggregate([
      { $match: { status: "pending" } },
      { $group: { _id: "$idType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Order.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      { $match: { status: "delivered", createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } },
          orders: { $sum: 1 },
          revenue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      { $match: { status: "disputed", createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }, disputes: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      { $match: { status: "disputed" } },
      { $group: { _id: "$escrowStatus", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  return success(res, {
    charts: {
      disputeEscrow: normalizeBucket(disputeEscrow, "escrowStatus"),
      disputeTrend: fillDailyTrend(disputeTrend, trendDays, ["disputes"]),
      kycStatus: normalizeBucket(kycStatus, "status"),
      listingStatus: normalizeBucket(listingStatus, "status"),
      listingTrend: fillDailyTrend(listingTrend, trendDays, ["listings"]),
      listingType: normalizeBucket(listingType, "type"),
      orderStatus: normalizeBucket(orderStatus, "status"),
      orderTrend: fillDailyTrend(orderTrend, trendDays, ["orders"]),
      pendingKycByIdType: normalizeBucket(pendingKycByIdType, "idType"),
      revenueTrend: fillDailyTrend(revenueTrend, trendDays, ["orders", "revenue"]),
      shopCategory: normalizeBucket(shopCategory, "category"),
      shopLive: shopLive.map((row) => ({ count: row.count, status: row._id ? "Live" : "Offline" })),
      shopTrend: fillDailyTrend(shopTrend, trendDays, ["shops"]),
      userStatus: normalizeBucket(userStatus, "status"),
      userTrend: fillDailyTrend(userTrend, trendDays, ["users"]),
      userVerification: userVerification.map((row) => ({
        count: row.count,
        status: row._id ? "Email verified" : "Email pending",
      })),
    },
    users,
    shops,
    orders,
    listings,
    pendingKyc,
    pendingOrders,
    disputes,
    revenue: revenue[0]?.total || 0,
  });
});

exports.analytics = asyncHandler(async (req, res) => {
  const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const since = analyticsSince(days);
  const errorTypes = ["js_error", "unhandled_rejection", "api_failure", "resource_error"];

  const [timeline, byType, bySource, bySeverity, recentErrors, totals] = await Promise.all([
    SiteAnalyticsEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $project: {
          bucket: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } },
          type: 1,
          severity: 1,
        },
      },
      {
        $group: {
          _id: "$bucket",
          apiFailures: { $sum: { $cond: [{ $eq: ["$type", "api_failure"] }, 1, 0] } },
          clientErrors: {
            $sum: {
              $cond: [{ $in: ["$type", ["js_error", "unhandled_rejection", "resource_error"]] }, 1, 0],
            },
          },
          critical: { $sum: { $cond: [{ $eq: ["$severity", "critical"] }, 1, 0] } },
          events: { $sum: 1 },
          pageViews: { $sum: { $cond: [{ $eq: ["$type", "page_view"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    SiteAnalyticsEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    SiteAnalyticsEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$source", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    SiteAnalyticsEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$severity", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    SiteAnalyticsEvent.find({
      createdAt: { $gte: since },
      $or: [{ type: { $in: errorTypes } }, { severity: { $in: ["error", "critical"] } }],
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("createdAt endpoint message method path severity source statusCode type url")
      .lean(),
    SiteAnalyticsEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          apiFailures: { $sum: { $cond: [{ $eq: ["$type", "api_failure"] }, 1, 0] } },
          clientErrors: {
            $sum: {
              $cond: [{ $in: ["$type", ["js_error", "unhandled_rejection", "resource_error"]] }, 1, 0],
            },
          },
          critical: { $sum: { $cond: [{ $eq: ["$severity", "critical"] }, 1, 0] } },
          events: { $sum: 1 },
          pageViews: { $sum: { $cond: [{ $eq: ["$type", "page_view"] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const summary = totals[0] || {
    apiFailures: 0,
    clientErrors: 0,
    critical: 0,
    events: 0,
    pageViews: 0,
  };

  return success(
    res,
    {
      bySeverity: bySeverity.map((item) => ({ count: item.count, severity: item._id || "unknown" })),
      bySource: bySource.map((item) => ({ count: item.count, source: item._id || "unknown" })),
      byType: byType.map((item) => ({ count: item.count, type: item._id || "unknown" })),
      days,
      recentErrors,
      summary: {
        ...summary,
        failureRate: summary.pageViews ? Number(((summary.apiFailures + summary.clientErrors) / summary.pageViews).toFixed(4)) : 0,
      },
      timeline: timeline.map((item) => ({
        apiFailures: item.apiFailures,
        clientErrors: item.clientErrors,
        critical: item.critical,
        date: item._id,
        events: item.events,
        pageViews: item.pageViews,
      })),
    },
    "Analytics loaded",
  );
});

exports.createAnnouncement = asyncHandler(async (req, res) => {
  const title = String(req.body.title || "").trim();
  const body = String(req.body.body || "").trim();
  const link = String(req.body.link || "").trim();
  const users = await User.find({
    $or: [{ accountStatus: "active" }, { accountStatus: { $exists: false } }],
  })
    .select("_id")
    .lean();

  await Promise.all(
    users.map((user) =>
      createNotification({
        userId: user._id,
        type: "system",
        title,
        body,
        link,
      }),
    ),
  );

  return success(res, { count: users.length }, "Announcement sent", 201);
});

exports.users = asyncHandler(async (req, res) => {
  const page = positiveInt(req.query.page, 1, 100000);
  const limit = positiveInt(req.query.limit, 20, 50);
  const search = String(req.query.search || "").trim();
  const filter = {};

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { name: searchRegex },
      { email: searchRegex },
      { username: searchRegex },
      { phone: searchRegex },
    ];

    if (mongoose.Types.ObjectId.isValid(search)) {
      filter.$or.push({ _id: search });
    }
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("name email username phone roles accountStatus isEmailVerified isKycVerified hasShop createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  return success(
    res,
    {
      limit,
      page,
      pages: total ? Math.ceil(total / limit) : 0,
      total,
      users,
    },
    "Users loaded",
  );
});

exports.promoteUser = asyncHandler(async (req, res) => {
  const roleKey = req.params.roleKey;
  const nextRoleCode = roleCodeForKey(roleKey);
  const nextRolePath = rolePath(roleKey);
  const standardUserRolePath = rolePath(ROLE_KEYS.STANDARD_USER);

  if (!nextRoleCode || !nextRolePath) throw httpError(422, "Unknown role");

  const user = await User.findByIdAndUpdate(
    req.params.userId,
    {
      $set: {
        [standardUserRolePath]: USER_ROLES.STANDARD_USER,
        [nextRolePath]: nextRoleCode,
      },
    },
    { new: true, runValidators: true },
  ).select("-passwordHash -refreshTokens");

  if (!user) throw httpError(404, "User not found");

  return success(res, { user }, "User role added");
});

exports.demoteUser = asyncHandler(async (req, res) => {
  const roleKey = req.params.roleKey;
  const nextRolePath = rolePath(roleKey);

  if (!nextRolePath) throw httpError(422, "Unknown role");

  const user = await User.findByIdAndUpdate(
    req.params.userId,
    { $unset: { [nextRolePath]: "" } },
    { new: true, runValidators: true },
  ).select("-passwordHash -refreshTokens");

  if (!user) throw httpError(404, "User not found");

  return success(res, { user }, "User role removed");
});

exports.pendingKyc = asyncHandler(async (req, res) => {
  const records = await KYC.find({ status: "pending" })
    .populate("userId", "name email username phone")
    .sort({ submittedAt: 1 });

  return success(res, { records }, "Pending KYC loaded");
});

exports.approvedKyc = asyncHandler(async (req, res) => {
  const query = req.validated?.query || req.query;
  const page = positiveInt(query.page, 1, 100000);
  const limit = positiveInt(query.limit, 50, 50);
  const search = String(query.search || "").trim();
  const filter = { status: "approved" };

  if (APPROVED_KYC_ID_TYPES.includes(query.idType)) {
    filter.idType = query.idType;
  }

  if (query.phoneVerified === "true") {
    filter.phoneVerified = true;
  }

  if (query.phoneVerified === "false") {
    filter.phoneVerified = false;
  }

  const reviewedWithinDays = Number.parseInt(query.reviewedWithin || "", 10);
  if ([7, 30, 90].includes(reviewedWithinDays)) {
    const reviewedSince = new Date();
    reviewedSince.setDate(reviewedSince.getDate() - reviewedWithinDays);
    filter.reviewedAt = { $gte: reviewedSince };
  }

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), "i");
    const users = await User.find({
      $or: [
        { name: searchRegex },
        { email: searchRegex },
        { username: searchRegex },
        { phone: searchRegex },
      ],
    })
      .select("_id")
      .limit(500)
      .lean();

    filter.$or = [
      { idNo: searchRegex },
      { phone: searchRegex },
      { idType: searchRegex },
      { userId: { $in: users.map((user) => user._id) } },
    ];
  }

  const sort =
    query.sort === "oldest"
      ? { reviewedAt: 1, updatedAt: 1, _id: 1 }
      : { reviewedAt: -1, updatedAt: -1, _id: -1 };
  const skip = (page - 1) * limit;

  const [records, total] = await Promise.all([
    KYC.find(filter)
      .populate("userId", "name email username phone isKycVerified")
      .populate("reviewedBy", "name email username")
      .sort(sort)
      .skip(skip)
      .limit(limit),
    KYC.countDocuments(filter),
  ]);

  return success(
    res,
    {
      limit,
      page,
      pages: total ? Math.ceil(total / limit) : 0,
      records,
      total,
    },
    "Approved KYC loaded",
  );
});

exports.getKyc = asyncHandler(async (req, res) => {
  const kyc = await KYC.findById(req.params.kycId).populate(
    "userId reviewedBy",
    "name email username roles phone",
  );

  if (!kyc) throw httpError(404, "KYC record not found");

  return success(res, { kyc }, "KYC loaded");
});

exports.approveKyc = asyncHandler(async (req, res) => {
  const kyc = await KYC.findById(req.params.kycId).populate("userId");
  if (!kyc) throw httpError(404, "KYC record not found");

  kyc.status = "approved";
  kyc.rejectionReason = "";
  kyc.reviewedAt = new Date();
  kyc.reviewedBy = req.user.id;
  await kyc.save();

  const user = await User.findByIdAndUpdate(
    kyc.userId._id,
    { isKycVerified: true, kycId: kyc._id },
    { new: true },
  );

  await sendKycApprovedEmail(user);
  await createNotification({
    userId: user._id,
    type: "kyc",
    title: "KYC approved",
    body: "Your verification badge is active.",
    link: "/account/kyc",
  });

  return success(res, { kyc }, "KYC approved");
});

exports.rejectKyc = asyncHandler(async (req, res) => {
  const kyc = await KYC.findById(req.params.kycId).populate("userId");
  if (!kyc) throw httpError(404, "KYC record not found");

  const rejectionReason = String(req.body.reason || "").trim();

  kyc.status = "rejected";
  kyc.rejectionReason = rejectionReason;
  kyc.reviewedAt = new Date();
  kyc.reviewedBy = req.user.id;
  await kyc.save();

  const user = await User.findByIdAndUpdate(
    kyc.userId._id,
    { isKycVerified: false, kycId: kyc._id },
    { new: true },
  );

  await sendKycRejectedEmail(user, rejectionReason);
  await createNotification({
    userId: user._id,
    type: "kyc",
    title: "KYC rejected",
    body: rejectionReason || "Your KYC submission was rejected. Please review your details and resubmit.",
    link: "/account/kyc",
  });

  return success(res, { kyc }, "KYC rejected");
});

exports.flaggedListings = asyncHandler(async (req, res) => {
  const listings = await Listing.find({ status: "removed" }).sort({ updatedAt: -1 });
  return success(res, { listings }, "Flagged listings loaded");
});

exports.removeListing = asyncHandler(async (req, res) => {
  const listing = await Listing.findById(req.params.id);

  if (!listing) throw httpError(404, "Listing not found");

  const previousListing = listing.toObject();
  listing.status = "removed";
  await listing.save();
  await syncListingHashtags(previousListing, listing);
  await runSearchSync(`listing:${listing._id}:admin-remove`, () =>
    syncListingSearchDocument(listing._id));

  return success(res, { listing }, "Listing removed");
});

exports.disputes = asyncHandler(async (req, res) => {
  const orders = await Order.find({ status: "disputed" })
    .populate("buyerId", "name email username")
    .populate("shopId", "shopName ownerId")
    .sort({ updatedAt: -1 });

  return success(res, { orders }, "Disputes loaded");
});

exports.resolveDispute = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.orderId,
    status: "disputed",
  }).populate("shopId", "ownerId shopName");

  if (!order) throw httpError(404, "Disputed order not found");
  if (!["seller", "buyer"].includes(req.body.resolveFor)) {
    throw httpError(422, "resolveFor must be seller or buyer");
  }

  if (req.body.resolveFor === "seller") {
    const seller = await User.findById(order.shopId.ownerId);
    seller.wallet.balance += order.totalAmount;
    seller.wallet.escrow = Math.max(seller.wallet.escrow - order.totalAmount, 0);
    await seller.save();
    order.escrowStatus = "released";
    order.status = "delivered";
  } else {
    const buyer = await User.findById(order.buyerId);
    buyer.wallet.balance += order.totalAmount;
    await buyer.save();
    order.escrowStatus = "refunded";
    order.status = "refunded";
  }

  order.disputeResolvedAt = new Date();
  await order.save();

  return success(res, { order }, "Dispute resolved");
});
