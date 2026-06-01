const Order = require("../models/Order");
const User = require("../models/User");
const DigiShop = require("../models/DigiShop");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const {
  initializeTransaction,
  verifyTransaction,
  initiateTransfer,
  verifyWebhookSignature,
} = require("../services/paystackService");
const { createNotification } = require("../services/notificationService");
const { sendSellerOrderEmail } = require("../services/emailService");

const orderPopulate = [
  { path: "shopId", select: "ownerId shopName slug" },
  { path: "buyerId", select: "name username email phone isKycVerified" },
  { path: "items.listingId", select: "title images price currency type" },
];

const markOrderPaid = async (order, reference, paymentMethod, buyer) => {
  if (order.paymentStatus === "paid") return order;

  order.status = "paid";
  order.paymentRef = reference;
  order.paymentMethod = paymentMethod === "cash_on_pickup" ? "cash_on_pickup" : "paystack";
  order.paymentStatus = "paid";
  order.paidAt = new Date();
  order.escrowStatus = "held";
  order.sellerActionDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
  await order.save();

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

  return success(res, { transaction }, "Payment initialized");
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
