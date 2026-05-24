const DigiShop = require("../models/DigiShop");
const KYC = require("../models/KYC");
const Listing = require("../models/Listing");
const Order = require("../models/Order");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const {
  sendKycApprovedEmail,
  sendKycRejectedEmail,
} = require("../services/emailService");
const { createNotification } = require("../services/notificationService");

exports.stats = asyncHandler(async (req, res) => {
  const [users, shops, orders, listings, revenue] = await Promise.all([
    User.countDocuments(),
    DigiShop.countDocuments(),
    Order.countDocuments(),
    Listing.countDocuments({ status: "active" }),
    Order.aggregate([
      { $match: { status: "delivered" } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
  ]);

  return success(res, {
    users,
    shops,
    orders,
    listings,
    revenue: revenue[0]?.total || 0,
  });
});

exports.pendingKyc = asyncHandler(async (req, res) => {
  const records = await KYC.find({ status: "pending" })
    .populate("userId", "name email username phone")
    .sort({ submittedAt: 1 });

  return success(res, { records }, "Pending KYC loaded");
});

exports.getKyc = asyncHandler(async (req, res) => {
  const kyc = await KYC.findById(req.params.kycId).populate(
    "userId reviewedBy",
    "name email username role phone",
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

  kyc.status = "rejected";
  kyc.rejectionReason = req.body.reason;
  kyc.reviewedAt = new Date();
  kyc.reviewedBy = req.user.id;
  await kyc.save();

  const user = await User.findByIdAndUpdate(
    kyc.userId._id,
    { isKycVerified: false, kycId: kyc._id },
    { new: true },
  );

  await sendKycRejectedEmail(user, req.body.reason);
  await createNotification({
    userId: user._id,
    type: "kyc",
    title: "KYC rejected",
    body: req.body.reason,
    link: "/account/kyc",
  });

  return success(res, { kyc }, "KYC rejected");
});

exports.flaggedListings = asyncHandler(async (req, res) => {
  const listings = await Listing.find({ status: "removed" }).sort({ updatedAt: -1 });
  return success(res, { listings }, "Flagged listings loaded");
});

exports.removeListing = asyncHandler(async (req, res) => {
  const listing = await Listing.findByIdAndUpdate(
    req.params.id,
    { status: "removed" },
    { new: true },
  );

  if (!listing) throw httpError(404, "Listing not found");

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
