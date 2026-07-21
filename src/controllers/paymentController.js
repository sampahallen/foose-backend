const Order = require("../models/Order");
const User = require("../models/User");
const DigiShop = require("../models/DigiShop");
const Event = require("../models/Event");
const Listing = require("../models/Listing");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { invalidate, invalidatePattern } = require("../utils/cache");
const {
  initializeTransaction,
  toInlinePayment,
  verifyTransaction,
  initiateTransfer,
  verifyWebhookSignature,
} = require("../services/paystackService");
const { createNotification } = require("../services/notificationService");
const { sendSellerOrderEmail } = require("../services/emailService");
const { awardPurchaseForOrder } = require("../services/recommendationService");
const { runSearchSync, syncListingSearchDocument } = require("../services/searchIndexService");

const orderPopulate = [
  { path: "shopId", select: "ownerId shopName slug" },
  { path: "buyerId", select: "name username email phone isKycVerified" },
  { path: "items.listingId", select: "title images price currency type" },
];

const PROMOTION_CONFIG = {
  event: {
    tags: ["featured", "home-featured", "home-banner"],
    packages: {
      basic: { amount: 1000, amountGhs: 10, durationDays: 7, label: "Basic featured event promotion" },
      lite: { amount: 3000, amountGhs: 30, durationDays: 30, label: "Lite featured event promotion" },
      premium: { amount: 7000, amountGhs: 70, durationDays: 90, label: "Premium featured event promotion" },
    },
  },
  listing: {
    tags: ["top-pick"],
    packages: {
      basic: { amount: 1000, amountGhs: 10, durationDays: 3, itemLimit: 10, label: "Basic Top Pick listing bundle" },
      lite: { amount: 3000, amountGhs: 30, durationDays: 7, itemLimit: 15, label: "Lite Top Pick listing bundle" },
      premium: { amount: 5000, amountGhs: 50, durationDays: 30, itemLimit: 30, label: "Premium Top Pick listing bundle" },
    },
  },
};

const promotionPackage = (targetType, packageName = "basic") => {
  const targetConfig = PROMOTION_CONFIG[targetType];
  const packageConfig = targetConfig?.packages?.[packageName] || targetConfig?.packages?.basic;
  if (!targetConfig || !packageConfig) return null;
  return {
    ...packageConfig,
    packageName: targetConfig.packages[packageName] ? packageName : "basic",
    tags: targetConfig.tags,
  };
};

const addUniqueTags = (currentTags, nextTags) =>
  Array.from(new Set([...(currentTags || []), ...nextTags].map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)));

const listingTargetIds = (targetId, targetIds) => {
  const ids = Array.isArray(targetIds) ? targetIds : targetIds ? [targetIds] : [];
  if (targetId) ids.push(targetId);
  return Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean)));
};

const loadPromotionTarget = async ({ targetId, targetIds, targetType, userId, itemLimit }) => {
  if (targetType === "listing") {
    const shop = await DigiShop.findOne({ ownerId: userId }).select("_id");
    if (!shop) throw httpError(403, "A DigiShop is required to promote listings");

    const ids = listingTargetIds(targetId, targetIds);
    if (!ids.length) throw httpError(422, "Choose at least one listing to promote");
    if (itemLimit && ids.length > itemLimit) {
      throw httpError(422, `This package supports up to ${itemLimit} listings`);
    }

    const listings = await Listing.find({
      _id: { $in: ids },
      shopId: shop._id,
      status: { $ne: "removed" },
    });
    if (listings.length !== ids.length) throw httpError(404, "One or more listings could not be found");

    return { targets: listings };
  }

  if (targetType === "event") {
    const event = await Event.findOne({ _id: targetId, organizerId: userId });
    if (!event) throw httpError(404, "Event not found");

    const endsAt = event.endsAt || event.date;
    if (endsAt && new Date(endsAt) < new Date()) {
      throw httpError(422, "Past events cannot be promoted");
    }

    return { target: event };
  }

  throw httpError(422, "Choose a valid promotion target");
};

const markOrderPaid = async (order, reference, paymentMethod, buyer) => {
  if (order.paymentStatus === "paid" || order.status === "cancelled") return order;

  const paidOrder = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: "unpaid", status: "pending" },
    {
      $set: {
        escrowStatus: "held",
        paidAt: new Date(),
        paymentMethod: paymentMethod === "cash_on_pickup" ? "cash_on_pickup" : "paystack",
        paymentRef: reference,
        paymentStatus: "paid",
        sellerActionDeadline: new Date(Date.now() + 48 * 60 * 60 * 1000),
        status: "paid",
      },
    },
    { new: true },
  );
  if (!paidOrder) return Order.findById(order._id);
  order = paidOrder;

  const recommendationOrder = await Order.findOneAndUpdate(
    { _id: order._id, recommendationAwardedAt: { $exists: false } },
    { $set: { recommendationAwardedAt: new Date() } },
    { new: true },
  ).lean();
  if (recommendationOrder) {
    await awardPurchaseForOrder(recommendationOrder).catch((error) => {
      console.warn(`Purchase recommendation signal failed: ${error.message}`);
    });
  }

  const shop = await DigiShop.findById(order.shopId);
  if (!shop) throw httpError(404, "Shop not found for order");
  const seller = await User.findById(shop.ownerId);
  if (!seller) throw httpError(404, "Seller not found for order");

  await User.updateOne(
    { _id: seller._id },
    { $inc: { "wallet.escrow": order.totalAmount } },
  );

  await Promise.all([
    createNotification({
      userId: seller._id,
      type: "order",
      title: "New paid order",
      body: "A buyer paid for an order. Funds are held in escrow.",
      link: `/manage-shop?orderId=${order._id}`,
    }),
    createNotification({
      userId: order.buyerId,
      type: "order",
      title: "Payment confirmed",
      body: `${shop.shopName} has 48 hours to process ${order.items[0]?.title || "your item"}.`,
      link: `/order-confirmed?orderId=${order._id}`,
    }),
    buyer ? sendSellerOrderEmail(seller, order, buyer) : Promise.resolve(),
  ]);

  return order;
};

exports.cancelPayment = asyncHandler(async (req, res) => {
  const reference = req.params.reference;
  const orders = await Order.find({
    buyerId: req.user.id,
    paymentRef: reference,
  });

  if (!orders.length) throw httpError(404, "Pending payment not found");

  const transaction = await verifyTransaction(reference);
  if (transaction.status === "success") {
    const buyer = await User.findById(req.user.id);
    const paidOrders = await Promise.all(
      orders.map((order) => markOrderPaid(order, reference, transaction.channel || "paystack", buyer)),
    );
    if (paidOrders.some((order) => order?.paymentStatus !== "paid")) {
      throw httpError(409, "Payment completed after cancellation; contact support with the payment reference");
    }
    return success(res, { cancelled: false, paid: true, releasedItemCount: 0, orders: paidOrders }, "Payment was already completed");
  }

  const cancelledOrders = (await Promise.all(
    orders.map((order) => Order.findOneAndUpdate(
      { _id: order._id, buyerId: req.user.id, paymentRef: reference, paymentStatus: "unpaid", status: "pending" },
      { $set: { checkoutCancelledAt: new Date(), escrowStatus: "not_held", status: "cancelled" } },
      { new: true },
    )),
  )).filter(Boolean);

  const releasedQuantities = new Map();
  cancelledOrders.forEach((order) => {
    order.items.forEach((item) => {
      if (!item.listingId) return;
      const listingId = String(item.listingId);
      releasedQuantities.set(listingId, (releasedQuantities.get(listingId) || 0) + Math.max(Number(item.quantity || 1), 1));
    });
  });

  await Promise.all(Array.from(releasedQuantities.entries()).map(async ([listingId, quantity]) => {
    await Listing.updateOne(
      { _id: listingId, status: { $ne: "removed" } },
      { $inc: { quantity }, $set: { status: "active" } },
    );
    await runSearchSync(`listing:${listingId}:payment-cancelled`, () => syncListingSearchDocument(listingId));
  }));

  await invalidate(
    "listings:featured",
    ...cancelledOrders.map((order) => `shop:${order.shopId}:listings`),
  );

  const currentOrders = cancelledOrders.length
    ? orders
    : await Order.find({ buyerId: req.user.id, paymentRef: reference });
  const alreadyCancelled = !cancelledOrders.length && currentOrders.every((order) => order.status === "cancelled");
  if (!cancelledOrders.length && !alreadyCancelled) {
    throw httpError(409, "Payment can no longer be cancelled");
  }

  return success(
    res,
    {
      cancelled: true,
      orderIds: orders.map((order) => order._id),
      paid: false,
      releasedItemCount: Array.from(releasedQuantities.values()).reduce((sum, quantity) => sum + quantity, 0),
    },
    alreadyCancelled ? "Payment was already cancelled" : "Payment cancelled and inventory released",
  );
});

exports.initializePayment = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.body.orderId,
    buyerId: req.user.id,
    status: "pending",
  });

  if (!order) throw httpError(404, "Pending order not found");

  const transaction = await initializeTransaction({
    callbackUrl: req.body.callbackUrl,
    email: req.user.email,
    amount: order.totalAmount,
    metadata: { orderId: order._id.toString(), buyerId: req.user.id },
  });

  order.paymentRef = transaction.reference;
  await order.save();

  return success(res, { payment: toInlinePayment(transaction) }, "Payment initialized");
});

exports.verifyPayment = asyncHandler(async (req, res) => {
  const transaction = await verifyTransaction(req.params.reference);
  const orders = await Order.find({
    paymentRef: req.params.reference,
    buyerId: req.user.id,
  });

  if (!orders.length) throw httpError(404, "Order not found for reference");
  if (transaction.status !== "success") {
    throw httpError(400, "Payment was not successful");
  }

  const expectedAmount = orders.reduce((sum, order) => sum + order.totalAmount, 0);
  if (Number(transaction.amount || 0) < expectedAmount) {
    throw httpError(400, "Payment amount does not match order total");
  }

  await Promise.all(
    orders.map((order) => markOrderPaid(order, req.params.reference, transaction.channel || "paystack", req.currentUser)),
  );

  const populatedOrders = await Order.find({ _id: { $in: orders.map((order) => order._id) } })
    .populate(orderPopulate)
    .sort({ createdAt: -1 });

  return success(
    res,
    { order: populatedOrders[0], orders: populatedOrders, transaction },
    "Payment verified",
  );
});

exports.initializePromotionPayment = asyncHandler(async (req, res) => {
  const targetType = req.body.targetType;
  const targetId = req.body.targetId;
  const config = promotionPackage(targetType, req.body.packageName);

  if (!config) throw httpError(422, "Choose listing or event promotion");

  const targetIds = listingTargetIds(targetId, req.body.targetIds);
  await loadPromotionTarget({ targetId, targetIds, targetType, userId: req.user.id, itemLimit: config.itemLimit });

  const transaction = await initializeTransaction({
    callbackUrl: req.body.callbackUrl,
    email: req.user.email,
    amount: config.amount,
    metadata: {
      amount: config.amount,
      amountGhs: config.amountGhs,
      label: config.label,
      packageName: config.packageName,
      purpose: "promotion",
      targetId,
      targetIds: targetType === "listing" ? targetIds : undefined,
      targetType,
      userId: req.user.id,
    },
  });

  return success(
    res,
    {
      payment: {
        ...toInlinePayment(transaction),
        amount: config.amount,
        amountGhs: config.amountGhs,
        targetId,
        targetIds: targetType === "listing" ? targetIds : undefined,
        targetType,
        packageName: config.packageName,
      },
    },
    "Promotion payment initialized",
  );
});

exports.verifyPromotionPayment = asyncHandler(async (req, res) => {
  const transaction = await verifyTransaction(req.params.reference);

  if (transaction.status !== "success") {
    throw httpError(400, "Promotion payment was not successful");
  }

  const metadata = transaction.metadata || {};
  const targetType = metadata.targetType;
  const targetId = metadata.targetId;
  const targetIds = listingTargetIds(targetId, metadata.targetIds);
  const config = promotionPackage(targetType, metadata.packageName);

  if (!config || metadata.purpose !== "promotion") {
    throw httpError(400, "Payment reference is not for a promotion");
  }

  if (String(metadata.userId) !== String(req.user.id)) {
    throw httpError(403, "Promotion payment belongs to another user");
  }

  if (Number(transaction.amount || 0) < config.amount) {
    throw httpError(400, "Promotion payment amount does not match the selected campaign");
  }

  const { target, targets } = await loadPromotionTarget({
    itemLimit: config.itemLimit,
    targetId,
    targetIds,
    targetType,
    userId: req.user.id,
  });

  if (targetType === "listing") {
    const now = new Date();
    await Promise.all(
      targets.map(async (listing) => {
        const activeUntil =
          listing.promotionExpiresAt && listing.promotionExpiresAt > now
            ? new Date(listing.promotionExpiresAt)
            : now;
        listing.promotionTags = addUniqueTags(listing.promotionTags, config.tags);
        listing.promotionExpiresAt = new Date(activeUntil.getTime() + config.durationDays * 24 * 60 * 60 * 1000);
        await listing.save();
        await invalidate("listings:featured", `listing:${listing._id}`, `shop:${listing.shopId}:listings`);
      }),
    );
    await invalidatePattern("search:top-picks:*");

    return success(
      res,
      {
        listing: targets[0],
        listings: targets,
        promotion: {
          amountGhs: config.amountGhs,
          endsAt: targets[0]?.promotionExpiresAt,
          itemLimit: config.itemLimit,
          packageName: config.packageName,
          reference: req.params.reference,
        },
        targetType,
      },
      "Listing promotion verified",
    );
  }

  target.promotionTags = addUniqueTags(target.promotionTags, config.tags);
  const now = new Date();
  const activeUntil =
    target.promotionExpiresAt && target.promotionExpiresAt > now
      ? new Date(target.promotionExpiresAt)
      : now;
  const requestedEndsAt = new Date(activeUntil.getTime() + config.durationDays * 24 * 60 * 60 * 1000);
  const eventEndsAt = target.endsAt || target.date;
  target.promotionExpiresAt = eventEndsAt && new Date(eventEndsAt) < requestedEndsAt ? new Date(eventEndsAt) : requestedEndsAt;
  await target.save();
  await invalidate("events:feed", "events:upcoming", "events:featured", `event:${target._id}`);

  return success(
    res,
    {
      event: target,
      promotion: {
        amountGhs: config.amountGhs,
        endsAt: target.promotionExpiresAt,
        packageName: config.packageName,
        reference: req.params.reference,
      },
      targetType,
    },
    "Event promotion verified",
  );
});

exports.webhook = asyncHandler(async (req, res) => {
  const rawBody = req.rawBody || JSON.stringify(req.body);
  const signature = req.headers["x-paystack-signature"];

  if (!verifyWebhookSignature(rawBody, signature)) {
    throw httpError(401, "Invalid Paystack signature");
  }

  if (req.body.event === "charge.success") {
    const reference = req.body.data.reference;
    const orders = await Order.find({ paymentRef: reference });

    await Promise.all(
      orders.map(async (order) => {
        const buyer = await User.findById(order.buyerId);
        return markOrderPaid(order, reference, req.body.data.channel || "paystack", buyer);
      }),
    );
  }

  return success(res, {}, "Webhook received");
});

exports.withdraw = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  const amount = Number(req.body.amount);

  if (amount <= 0) throw httpError(400, "Withdrawal amount must be positive");
  if (user.wallet.balance < amount) throw httpError(400, "Insufficient balance");

  const transfer = await initiateTransfer({
    amount,
    recipient: req.body.recipient,
    reason: req.body.reason || "ThriftGH wallet withdrawal",
  });

  user.wallet.balance -= amount;
  await user.save();

  return success(res, { transfer, wallet: user.wallet }, "Withdrawal initiated");
});
