const DigiShop = require("../models/DigiShop");
const FinspoComment = require("../models/FinspoComment");
const GalleryPost = require("../models/GalleryPost");
const KYC = require("../models/KYC");
const Listing = require("../models/Listing");
const Order = require("../models/Order");
const OrderReport = require("../models/OrderReport");
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
const { resolveOrderReport } = require("../services/orderLifecycleService");
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

// Merges several independently date-grouped aggregation results (e.g. orders created vs.
// orders completed, grouped on different date fields) into one zero-filled daily series.
function mergeDailySeries(days, series) {
  const maps = series.map(({ rows }) => new Map(rows.map((row) => [row._id, row.count])));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (days - index - 1));
    date.setUTCHours(0, 0, 0, 0);
    const key = date.toISOString().slice(0, 10);
    const point = { date: key };
    series.forEach(({ key: seriesKey }, seriesIndex) => {
      point[seriesKey] = maps[seriesIndex].get(key) || 0;
    });
    return point;
  });
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
    OrderReport.countDocuments({ isActive: true }),
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
    OrderReport.aggregate([
      { $match: { isActive: true, submittedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$submittedAt", format: "%Y-%m-%d" } }, disputes: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    OrderReport.aggregate([
      { $match: { isActive: true } },
      {
        $lookup: {
          from: Order.collection.name,
          localField: "orderId",
          foreignField: "_id",
          as: "order",
        },
      },
      { $unwind: "$order" },
      { $group: { _id: "$order.settlementStatus", count: { $sum: 1 } } },
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

  const [
    ordersCreated,
    ordersCompleted,
    revenueAgg,
    orderCreatedTrendRows,
    orderCompletedTrendRows,
    outcomeBreakdownRows,
    finspoPostsCreated,
    finspoComments,
    finspoTotalsAgg,
    finspoPostsTrendRows,
    finspoCommentsTrendRows,
    topPosts,
  ] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: since } }),
    Order.countDocuments({ completedAt: { $gte: since } }),
    Order.aggregate([
      { $match: { completedAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { completedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$completedAt", format: "%Y-%m-%d" } }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $project: { outcome: { $cond: [{ $eq: ["$status", "disputed"] }, "disputed", "$fulfillmentStatus"] } } },
      { $group: { _id: "$outcome", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    GalleryPost.countDocuments({ createdAt: { $gte: since }, isArchived: false }),
    FinspoComment.countDocuments({ createdAt: { $gte: since } }),
    GalleryPost.aggregate([
      { $match: { isArchived: false } },
      { $group: { _id: null, totalLikes: { $sum: { $size: "$likes" } }, totalViews: { $sum: "$views" } } },
    ]),
    GalleryPost.aggregate([
      { $match: { isArchived: false, createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }, count: { $sum: 1 } } },
    ]),
    FinspoComment.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }, count: { $sum: 1 } } },
    ]),
    GalleryPost.find({ isArchived: false })
      .sort({ views: -1, createdAt: -1 })
      .limit(10)
      .select("caption imageUrl userId views likes commentCount createdAt")
      .populate("userId", "name username")
      .lean(),
  ]);

  const revenue = revenueAgg[0]?.total || 0;
  const finspoTotals = finspoTotalsAgg[0] || { totalLikes: 0, totalViews: 0 };

  return success(
    res,
    {
      days,
      finspo: {
        comments: finspoComments,
        postsCreated: finspoPostsCreated,
        topPosts: topPosts.map((post) => ({
          _id: post._id,
          author: post.userId && typeof post.userId === "object"
            ? { name: post.userId.name, username: post.userId.username }
            : { name: "Unknown seller", username: "" },
          caption: post.caption || "",
          commentCount: post.commentCount || 0,
          createdAt: post.createdAt,
          imageUrl: post.imageUrl,
          likes: post.likes?.length || 0,
          views: post.views || 0,
        })),
        totalLikes: finspoTotals.totalLikes,
        totalViews: finspoTotals.totalViews,
        trend: mergeDailySeries(days, [
          { key: "posts", rows: finspoPostsTrendRows },
          { key: "comments", rows: finspoCommentsTrendRows },
        ]),
      },
      orders: {
        completed: ordersCompleted,
        completionRate: ordersCreated ? Number((ordersCompleted / ordersCreated).toFixed(4)) : 0,
        created: ordersCreated,
        outcomeBreakdown: normalizeBucket(outcomeBreakdownRows, "outcome"),
        revenue,
        trend: mergeDailySeries(days, [
          { key: "created", rows: orderCreatedTrendRows },
          { key: "completed", rows: orderCompletedTrendRows },
        ]),
      },
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
  const reports = await OrderReport.find({ isActive: true })
    .populate("buyerId", "name email username phone location")
    .populate({
      path: "shopId",
      select: "shopName ownerId location",
      populate: {
        path: "ownerId",
        select: "name email username phone location",
      },
    })
    .populate({
      path: "orderId",
      populate: [
        { path: "buyerId", select: "name email username phone location" },
        {
          path: "shopId",
          select: "shopName ownerId location",
          populate: {
            path: "ownerId",
            select: "name email username phone location",
          },
        },
      ],
    })
    .sort({ submittedAt: 1, _id: 1 });

  return success(
    res,
    {
      orders: reports.map((report) => report.orderId).filter(Boolean),
      readOnly: false,
      reports,
    },
    "Order reports loaded",
  );
});

exports.resolveDispute = asyncHandler(async (req, res) => {
  const result = await resolveOrderReport({
    awardedTo: req.body.resolveFor,
    note: req.body.note,
    orderId: req.params.orderId,
    resolverId: req.user.id,
  });
  return success(
    res,
    result,
    req.body.resolveFor === "buyer"
      ? "Report resolved and buyer refund started"
      : "Report resolved and funds released to seller",
  );
});
