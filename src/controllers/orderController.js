const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const Order = require("../models/Order");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { estimateDeliveryFee } = require("../services/deliveryService");
const { createNotification } = require("../services/notificationService");

const getOrderForParticipant = async (orderId, userId) => {
  const order = await Order.findById(orderId).populate("shopId", "ownerId shopName");

  if (!order) throw httpError(404, "Order not found");

  const isBuyer = order.buyerId.toString() === userId;
  const isSeller = order.shopId.ownerId.toString() === userId;

  if (!isBuyer && !isSeller) {
    throw httpError(403, "You do not have access to this order");
  }

  return { order, isBuyer, isSeller };
};

exports.placeOrder = asyncHandler(async (req, res) => {
  const requestedItems = req.body.items || [];

  if (!requestedItems.length) {
    throw httpError(422, "At least one order item is required");
  }

  const listingIds = requestedItems.map((item) => item.listingId);
  const listings = await Listing.find({
    _id: { $in: listingIds },
    status: "active",
  });

  if (listings.length !== requestedItems.length) {
    throw httpError(400, "One or more listings are unavailable");
  }

  const shopId = listings[0].shopId.toString();

  if (listings.some((listing) => listing.shopId.toString() !== shopId)) {
    throw httpError(400, "Orders can only contain listings from one DigiShop");
  }

  const items = requestedItems.map((item) => {
    const listing = listings.find(
      (candidate) => candidate._id.toString() === item.listingId,
    );
    const quantity = Math.max(Number(item.quantity || 1), 1);

    if (listing.quantity < quantity) {
      throw httpError(400, `${listing.title} does not have enough stock`);
    }

    return {
      listingId: listing._id,
      title: listing.title,
      price: listing.price,
      quantity,
    };
  });

  const itemTotal = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const deliveryFee = estimateDeliveryFee({
    region: req.body.delivery?.address?.region,
    method: req.body.delivery?.method,
  });

  const order = await Order.create({
    buyerId: req.user.id,
    shopId,
    items,
    totalAmount: itemTotal + deliveryFee,
    delivery: {
      ...req.body.delivery,
      fee: deliveryFee,
    },
  });

  return success(res, { order }, "Order placed", 201);
});

exports.getBuyingOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({ buyerId: req.user.id })
    .populate("shopId", "shopName slug")
    .sort({ createdAt: -1 });

  return success(res, { orders }, "Buying orders loaded");
});

exports.getSellingOrders = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id });
  const orders = await Order.find({ shopId: shop?._id })
    .populate("buyerId", "name username isKycVerified")
    .sort({ createdAt: -1 });

  return success(res, { orders }, "Selling orders loaded");
});

exports.getOrder = asyncHandler(async (req, res) => {
  const { order } = await getOrderForParticipant(req.params.id, req.user.id);
  return success(res, { order }, "Order loaded");
});

exports.markShipped = asyncHandler(async (req, res) => {
  const { order, isSeller } = await getOrderForParticipant(req.params.id, req.user.id);

  if (!isSeller) throw httpError(403, "Only the shop owner can ship this order");
  if (!["paid", "processing"].includes(order.status)) {
    throw httpError(400, "Order must be paid before shipping");
  }

  order.status = "shipped";
  order.delivery = order.delivery || {};
  order.delivery.trackingInfo = req.body.trackingInfo || order.delivery.trackingInfo;
  await order.save();

  await createNotification({
    userId: order.buyerId,
    type: "order",
    title: "Order shipped",
    body: `${order.shopId.shopName} marked your order as shipped.`,
    link: `/orders/${order._id}`,
  });

  return success(res, { order }, "Order marked as shipped");
});

exports.confirmDelivery = asyncHandler(async (req, res) => {
  const { order, isBuyer } = await getOrderForParticipant(req.params.id, req.user.id);

  if (!isBuyer) throw httpError(403, "Only the buyer can confirm delivery");
  if (order.status !== "shipped") {
    throw httpError(400, "Only shipped orders can be confirmed delivered");
  }

  order.status = "delivered";
  order.escrowStatus = "released";
  await order.save();

  const seller = await User.findById(order.shopId.ownerId);
  seller.wallet.balance += order.totalAmount;
  seller.wallet.escrow = Math.max(seller.wallet.escrow - order.totalAmount, 0);
  await seller.save();

  await createNotification({
    userId: seller._id,
    type: "order",
    title: "Escrow released",
    body: "A buyer confirmed delivery. Funds are now in your wallet.",
    link: `/orders/${order._id}`,
  });

  return success(res, { order }, "Delivery confirmed");
});

exports.raiseDispute = asyncHandler(async (req, res) => {
  const { order } = await getOrderForParticipant(req.params.id, req.user.id);

  order.status = "disputed";
  order.disputeReason = req.body.reason;
  await order.save();

  return success(res, { order }, "Dispute raised");
});
