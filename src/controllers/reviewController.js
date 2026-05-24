const DigiShop = require("../models/DigiShop");
const Order = require("../models/Order");
const Review = require("../models/Review");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { createNotification } = require("../services/notificationService");
const { withCache, invalidate } = require("../utils/cache");

const recalculateShopRating = async (shopId) => {
  const stats = await Review.aggregate([
    { $match: { shopId } },
    {
      $group: {
        _id: "$shopId",
        rating: { $avg: "$rating" },
        totalReviews: { $sum: 1 },
      },
    },
  ]);

  const values = stats[0] || { rating: 0, totalReviews: 0 };
  await DigiShop.findByIdAndUpdate(shopId, {
    rating: Math.round(values.rating * 10) / 10,
    totalReviews: values.totalReviews,
  });
};

exports.createReview = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.body.orderId,
    buyerId: req.user.id,
    status: "delivered",
  }).populate("shopId", "ownerId shopName");

  if (!order) {
    throw httpError(400, "Review requires a delivered order");
  }

  const existingReview = await Review.findOne({ orderId: order._id });
  if (existingReview) throw httpError(409, "Order has already been reviewed");

  const review = await Review.create({
    reviewerId: req.user.id,
    shopId: order.shopId._id,
    orderId: order._id,
    rating: req.body.rating,
    comment: req.body.comment,
  });

  await recalculateShopRating(order.shopId._id);
  await invalidate(`reviews:${order.shopId._id}`);
  await createNotification({
    userId: order.shopId.ownerId,
    type: "review",
    title: "New review",
    body: `${order.shopId.shopName} received a new review.`,
    link: `/shops/${order.shopId._id}/reviews`,
  });

  return success(res, { review }, "Review created", 201);
});

exports.getShopReviews = asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const filter = { shopId: req.params.shopId };
  const fetchReviews = async () => {
    const [reviews, total] = await Promise.all([
      Review.find(filter)
        .populate("reviewerId", "name username profilePhoto isKycVerified")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Review.countDocuments(filter),
    ]);

    return {
      reviews,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  };

  const data =
    page === 1 && limit === 20
      ? await withCache(`reviews:${req.params.shopId}`, 300, fetchReviews)
      : await fetchReviews();

  return success(res, data);
});
