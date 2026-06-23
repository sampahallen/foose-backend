const DigiShop = require("../models/DigiShop");
const mongoose = require("mongoose");
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
  let shop;
  let orderId;

  if (req.body.orderId) {
    const order = await Order.findOne({
      _id: req.body.orderId,
      buyerId: req.user.id,
      status: "delivered",
    }).populate("shopId", "ownerId shopName slug");

    if (!order) {
      throw httpError(400, "Review requires a delivered order");
    }

    const existingReview = await Review.findOne({ orderId: order._id });
    if (existingReview) throw httpError(409, "Order has already been reviewed");

    shop = order.shopId;
    orderId = order._id;
  } else {
    shop = await DigiShop.findById(req.body.shopId).select("ownerId shopName slug");

    if (!shop) throw httpError(404, "DigiShop not found");
    if (shop.ownerId.toString() === req.user.id) throw httpError(422, "You cannot review your own shop");

    const existingReview = await Review.findOne({
      reviewerId: req.user.id,
      shopId: shop._id,
      source: "direct",
    });
    if (existingReview) throw httpError(409, "You have already reviewed this shop");
  }

  const review = await Review.create({
    reviewerId: req.user.id,
    shopId: shop._id,
    orderId: orderId || new mongoose.Types.ObjectId(),
    source: orderId ? "order" : "direct",
    rating: req.body.rating,
    comment: req.body.comment,
  });

  await recalculateShopRating(shop._id);
  await invalidate(`reviews:${shop._id}`);
  await createNotification({
    userId: shop.ownerId,
    type: "review",
    title: "New review",
    body: `${shop.shopName} received a new review.`,
    link: shop.slug ? `/shops/${shop.slug}` : `/shops/${shop._id}`,
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

exports.deleteReview = asyncHandler(async (req, res) => {
  const review = await Review.findOneAndDelete({
    _id: req.params.reviewId,
    reviewerId: req.user.id,
  });

  if (!review) throw httpError(404, "Review not found");

  await recalculateShopRating(review.shopId);
  await invalidate(`reviews:${review.shopId}`);

  return success(res, {}, "Review deleted");
});

exports.updateReview = asyncHandler(async (req, res) => {
  const review = await Review.findOne({
    _id: req.params.reviewId,
    reviewerId: req.user.id,
  });

  if (!review) throw httpError(404, "Review not found");

  review.rating = req.body.rating;
  review.comment = req.body.comment;
  await review.save();

  await recalculateShopRating(review.shopId);
  await invalidate(`reviews:${review.shopId}`);

  return success(res, { review }, "Review updated");
});
