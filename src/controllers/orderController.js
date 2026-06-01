const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const Order = require("../models/Order");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { invalidate } = require("../utils/cache");
const { estimateDeliveryFee } = require("../services/deliveryService");
const { createNotification } = require("../services/notificationService");
const { sendSellerOrderEmail } = require("../services/emailService");
const { initializeTransaction } = require("../services/paystackService");

const SELLER_ACTION_WINDOW_MS = 48 * 60 * 60 * 1000;
const ESCROW_RELEASE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const orderPopulate = [
  { path: "shopId", select: "ownerId shopName slug" },
  { path: "buyerId", select: "name username email phone isKycVerified" },
  { path: "items.listingId", select: "title images price currency type" },
];

const getOrderForParticipant = async (orderId, userId) => {
  const order = await Order.findById(orderId).populate(orderPopulate);

  if (!order) throw httpError(404, "Order not found");

  const isBuyer = order.buyerId._id.toString() === userId;
  const isSeller = order.shopId.ownerId.toString() === userId;

  if (!isBuyer && !isSeller) {
    throw httpError(403, "You do not have access to this order");
  }

  return { order, isBuyer, isSeller };
};

const releaseOrderFunds = async (order, reason = "buyer_confirmed") => {
  if (order.escrowStatus !== "held" || order.paymentStatus !== "paid") return order;

  const shop = order.shopId?.ownerId ? order.shopId : await DigiShop.findById(order.shopId);
  if (!shop) return order;

  const seller = await User.findById(shop.ownerId);
  if (!seller) return order;

  seller.wallet.balance += order.totalAmount;
  seller.wallet.escrow = Math.max((seller.wallet.escrow || 0) - order.totalAmount, 0);
  await seller.save();

  order.status = "delivered";
  order.escrowStatus = "released";
  order.releasedAt = new Date();
  if (reason === "buyer_confirmed") order.buyerConfirmedAt = new Date();
  await order.save();

  await createNotification({
    userId: seller._id,
    type: "order",
    title: "Escrow released",
    body:
      reason === "auto_release"
        ? "A buyer took no action for 3 days, so funds were released automatically."
        : "A buyer confirmed delivery. Funds are now in your wallet.",
    link: `/orders/${order._id}`,
  });

  return order;
};

const releaseDueEscrows = async () => {
  const dueOrders = await Order.find({
    autoReleaseAt: { $lte: new Date() },
    escrowStatus: "held",
    paymentStatus: "paid",
    status: { $in: ["processing", "shipped"] },
  }).populate("shopId", "ownerId shopName slug");

  await Promise.all(dueOrders.map((order) => releaseOrderFunds(order, "auto_release")));
};

const notifySeller = async ({ order, shop, seller, buyer }) => {
  await Promise.all([
    createNotification({
      userId: seller._id,
      type: "order",
      title: order.paymentStatus === "paid" ? "New paid order" : "New pickup order",
      body:
        order.paymentStatus === "paid"
          ? "A buyer paid for an item. Funds are held in escrow until delivery is confirmed."
          : "A buyer requested cash on pickup. Confirm the pickup details in your shop dashboard.",
      link: `/manage-shop?orderId=${order._id}`,
    }),
    sendSellerOrderEmail(seller, order, buyer),
  ]);

  await createNotification({
    userId: buyer._id,
    type: "order",
    title: "Order sent to seller",
    body: `${shop.shopName} has 48 hours to process ${order.items[0]?.title || "your item"}.`,
    link: `/order-confirmed?orderId=${order._id}`,
  });
};

const assertSellerCanAct = (order, userId) => {
  if (order.shopId.ownerId.toString() !== userId) {
    throw httpError(403, "Only the shop owner can update this order");
  }
};

exports.placeOrder = asyncHandler(async (req, res) => {
  const requestedItems = req.body.items || [];

  if (!requestedItems.length) {
    throw httpError(422, "At least one order item is required");
  }

  const method = req.body.delivery?.method || "delivery";
  const requestedPaymentMethod = req.body.paymentMethod || "paystack";
  const paymentMethod = requestedPaymentMethod === "paystack_mock" ? "paystack" : requestedPaymentMethod;

  if (method === "delivery" && paymentMethod === "cash_on_pickup") {
    throw httpError(400, "Cash on pickup is only available for pickup orders");
  }

  const listingIds = requestedItems.map((item) => item.listingId);
  const listings = await Listing.find({
    _id: { $in: listingIds },
    status: "active",
  }).populate("shopId", "ownerId shopName slug");

  if (listings.length !== requestedItems.length) {
    throw httpError(400, "One or more listings are unavailable");
  }

  const orderLines = requestedItems.map((item) => {
    const listing = listings.find((candidate) => candidate._id.toString() === item.listingId);
    const quantity = Math.max(Number(item.quantity || 1), 1);

    if (listing.type === "retail" && quantity !== 1) {
      throw httpError(400, `${listing.title} is a single-item retail listing`);
    }

    if (listing.type === "wholesale" && listing.bulkMinQty && quantity < listing.bulkMinQty) {
      throw httpError(400, `${listing.title} requires a minimum order quantity of ${listing.bulkMinQty}`);
    }

    if (listing.quantity < quantity) {
      throw httpError(400, `${listing.title} does not have enough stock`);
    }

    return {
      listing,
      quantity,
      subtotalAmount: listing.price * quantity,
    };
  });

  const deliveryFeeTotal = estimateDeliveryFee({
    region: req.body.delivery?.address?.region,
    method,
  });
  const buyer = await User.findById(req.user.id);
  const now = new Date();
  const paidOnline = paymentMethod === "paystack";
  const createdOrders = [];

  for (let index = 0; index < orderLines.length; index += 1) {
    const line = orderLines[index];
    const isLast = index === orderLines.length - 1;
    const baseDeliveryShare = Math.floor(deliveryFeeTotal / orderLines.length);
    const allocatedDeliveryFee = isLast
      ? deliveryFeeTotal - baseDeliveryShare * (orderLines.length - 1)
      : baseDeliveryShare;
    const shop = line.listing.shopId;
    const seller = await User.findById(shop.ownerId);

    const order = await Order.create({
      buyerId: req.user.id,
      shopId: shop._id,
      items: [
        {
          listingId: line.listing._id,
          title: line.listing.title,
          price: line.listing.price,
          quantity: line.quantity,
        },
      ],
      subtotalAmount: line.subtotalAmount,
      deliveryFee: allocatedDeliveryFee,
      totalAmount: line.subtotalAmount + allocatedDeliveryFee,
      currency: line.listing.currency || "GHS",
      status: "pending",
      paymentMethod,
      paymentStatus: paidOnline ? "unpaid" : "cash_on_pickup",
      escrowStatus: "not_held",
      sellerActionDeadline: paidOnline ? undefined : new Date(now.getTime() + SELLER_ACTION_WINDOW_MS),
      delivery: {
        ...req.body.delivery,
        fee: allocatedDeliveryFee,
        method,
      },
    });

    if (!paidOnline) await notifySeller({ buyer, order, seller, shop });
    createdOrders.push(order);
  }

  await Promise.all(
    orderLines.map((line) => {
      const nextQuantity = Math.max((line.listing.quantity || 0) - line.quantity, 0);

      if (line.listing.type === "retail" || nextQuantity === 0) {
        return Listing.updateOne(
          { _id: line.listing._id },
          { $set: { quantity: 0, status: "sold" } },
        );
      }

      return Listing.updateOne(
        { _id: line.listing._id },
        { $inc: { quantity: -line.quantity } },
      );
    }),
  );

  await invalidate(
    "listings:featured",
    ...orderLines.map((line) => `shop:${line.listing.shopId._id}:listings`),
    ...orderLines.map((line) => `listing:${line.listing._id}`),
  );

  const orders = await Order.find({ _id: { $in: createdOrders.map((order) => order._id) } })
    .populate(orderPopulate)
    .sort({ createdAt: -1 });

  if (paidOnline) {
    try {
      const transaction = await initializeTransaction({
        callbackUrl: req.body.callbackUrl,
        email: buyer.email,
        amount: orders.reduce((sum, order) => sum + order.totalAmount, 0),
        metadata: {
          buyerId: req.user.id,
          orderIds: orders.map((order) => order._id.toString()),
        },
      });

      await Order.updateMany(
        { _id: { $in: orders.map((order) => order._id) } },
        { $set: { paymentRef: transaction.reference } },
      );

      const pendingOrders = orders.map((order) => {
        order.paymentRef = transaction.reference;
        return order;
      });

      return success(
        res,
        {
          order: pendingOrders[0],
          orders: pendingOrders,
          payment: {
            accessCode: transaction.access_code,
            authorizationUrl: transaction.authorization_url,
            provider: "paystack",
            reference: transaction.reference,
            status: "pending",
          },
        },
        "Payment initialized. Redirect the buyer to Paystack.",
        201,
      );
    } catch (error) {
      await Promise.all([
        Order.updateMany(
          { _id: { $in: createdOrders.map((order) => order._id) } },
          { $set: { status: "cancelled", escrowStatus: "not_held", paymentStatus: "unpaid" } },
        ),
        ...orderLines.map((line) =>
          Listing.updateOne(
            { _id: line.listing._id },
            { $inc: { quantity: line.quantity }, $set: { status: "active" } },
          ),
        ),
      ]);

      throw error;
    }
  }

  return success(
    res,
    {
      order: orders[0],
      orders,
      payment: { provider: "cash", mode: "pickup", status: "pending" },
    },
    "Pickup order placed",
    201,
  );
});

exports.getOrdersByIds = asyncHandler(async (req, res, next) => {
  if (!req.query.ids) return next();

  const ids = String(req.query.ids)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  await releaseDueEscrows();

  const orders = await Order.find({
    _id: { $in: ids },
    buyerId: req.user.id,
  })
    .populate(orderPopulate)
    .sort({ createdAt: -1 });

  return success(res, { orders }, "Orders loaded");
});

exports.getBuyingOrders = asyncHandler(async (req, res) => {
  await releaseDueEscrows();

  const orders = await Order.find({ buyerId: req.user.id })
    .populate("shopId", "shopName slug")
    .populate("items.listingId", "title images price currency type")
    .sort({ createdAt: -1 });

  return success(res, { orders }, "Buying orders loaded");
});

exports.getSellingOrders = asyncHandler(async (req, res) => {
  await releaseDueEscrows();

  const shop = await DigiShop.findOne({ ownerId: req.user.id });
  if (!shop) return success(res, { orders: [] }, "Selling orders loaded");

  const orders = await Order.find({ shopId: shop._id })
    .populate("buyerId", "name username email phone isKycVerified")
    .populate("items.listingId", "title images price currency type")
    .sort({ createdAt: -1 });

  return success(res, { orders }, "Selling orders loaded");
});

exports.getOrder = asyncHandler(async (req, res) => {
  await releaseDueEscrows();
  const { order } = await getOrderForParticipant(req.params.id, req.user.id);
  return success(res, { order }, "Order loaded");
});

exports.processOrder = asyncHandler(async (req, res) => {
  const { order } = await getOrderForParticipant(req.params.id, req.user.id);
  assertSellerCanAct(order, req.user.id);

  if (!["pending", "paid"].includes(order.status)) {
    throw httpError(400, "Only pending or paid orders can be processed");
  }

  order.status = "processing";
  order.sellerAction = "accepted";
  order.sellerActionAt = new Date();
  order.sellerNote = req.body.note || order.sellerNote;
  await order.save();

  await createNotification({
    userId: order.buyerId._id,
    type: "order",
    title: "Seller is processing your order",
    body: `${order.shopId.shopName} accepted ${order.items[0]?.title || "your item"}.`,
    link: `/order-confirmed?orderId=${order._id}`,
  });

  return success(res, { order }, "Order accepted for processing");
});

exports.markShipped = asyncHandler(async (req, res) => {
  const { order } = await getOrderForParticipant(req.params.id, req.user.id);
  assertSellerCanAct(order, req.user.id);

  if (order.delivery?.method !== "delivery") {
    throw httpError(400, "Only delivery orders can be marked as sent");
  }

  if (!["paid", "processing"].includes(order.status)) {
    throw httpError(400, "Order must be paid or processing before shipping");
  }

  order.status = "shipped";
  order.sellerAction = "shipped";
  order.sellerActionAt = new Date();
  order.autoReleaseAt = new Date(Date.now() + ESCROW_RELEASE_WINDOW_MS);
  order.delivery = order.delivery || {};
  order.delivery.trackingInfo = req.body.trackingInfo || order.delivery.trackingInfo;
  await order.save();

  await createNotification({
    userId: order.buyerId._id,
    type: "order",
    title: "Order sent",
    body: `${order.shopId.shopName} marked ${order.items[0]?.title || "your item"} as sent.`,
    link: `/order-confirmed?orderId=${order._id}`,
  });

  return success(res, { order }, "Order marked as sent");
});

exports.markPickupReady = asyncHandler(async (req, res) => {
  const { order } = await getOrderForParticipant(req.params.id, req.user.id);
  assertSellerCanAct(order, req.user.id);

  if (order.delivery?.method !== "pickup") {
    throw httpError(400, "Only pickup orders can be marked pickup-ready");
  }

  if (!["pending", "paid", "processing"].includes(order.status)) {
    throw httpError(400, "This order cannot be marked pickup-ready");
  }

  order.status = "processing";
  order.sellerAction = "pickup_ready";
  order.sellerActionAt = new Date();
  order.sellerNote = req.body.note || order.sellerNote;
  if (order.paymentStatus === "paid") {
    order.autoReleaseAt = new Date(Date.now() + ESCROW_RELEASE_WINDOW_MS);
  }
  await order.save();

  await createNotification({
    userId: order.buyerId._id,
    type: "order",
    title: "Pickup is ready",
    body: `${order.shopId.shopName} marked ${order.items[0]?.title || "your item"} as ready for pickup.`,
    link: `/order-confirmed?orderId=${order._id}`,
  });

  return success(res, { order }, "Pickup marked ready");
});

exports.confirmDelivery = asyncHandler(async (req, res) => {
  const { order, isBuyer } = await getOrderForParticipant(req.params.id, req.user.id);

  if (!isBuyer) throw httpError(403, "Only the buyer can confirm delivery");
  if (!["processing", "shipped"].includes(order.status)) {
    throw httpError(400, "Only processing or sent orders can be confirmed");
  }

  if (order.paymentStatus === "paid") {
    await releaseOrderFunds(order, "buyer_confirmed");
  } else {
    order.status = "delivered";
    order.buyerConfirmedAt = new Date();
    await order.save();
  }

  return success(res, { order }, "Order confirmed received");
});

exports.raiseDispute = asyncHandler(async (req, res) => {
  const { order } = await getOrderForParticipant(req.params.id, req.user.id);

  order.status = "disputed";
  order.disputeReason = req.body.reason;
  await order.save();

  return success(res, { order }, "Dispute raised");
});
