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

const markOrderPaid = async (order, reference, paymentMethod) => {
  if (order.status === "paid") return order;

  order.status = "paid";
  order.paymentRef = reference;
  order.paymentMethod = paymentMethod || order.paymentMethod;
  order.escrowStatus = "held";
  await order.save();

  const shop = await DigiShop.findById(order.shopId);
  const seller = await User.findById(shop.ownerId);
  seller.wallet.escrow += order.totalAmount;
  await seller.save();

  await createNotification({
    userId: seller._id,
    type: "order",
    title: "New paid order",
    body: "A buyer paid for an order. Funds are held in escrow.",
    link: `/orders/${order._id}`,
  });

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
  const order = await Order.findOne({
    paymentRef: req.params.reference,
    buyerId: req.user.id,
  });

  if (!order) throw httpError(404, "Order not found for reference");
  if (transaction.status !== "success") {
    throw httpError(400, "Payment was not successful");
  }

  await markOrderPaid(order, req.params.reference, transaction.channel);

  return success(res, { order, transaction }, "Payment verified");
});

exports.webhook = asyncHandler(async (req, res) => {
  const rawBody = req.rawBody || JSON.stringify(req.body);
  const signature = req.headers["x-paystack-signature"];

  if (!verifyWebhookSignature(rawBody, signature)) {
    throw httpError(401, "Invalid Paystack signature");
  }

  if (req.body.event === "charge.success") {
    const reference = req.body.data.reference;
    const order = await Order.findOne({ paymentRef: reference });

    if (order) {
      await markOrderPaid(order, reference, req.body.data.channel);
    }
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
