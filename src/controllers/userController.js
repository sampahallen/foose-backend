const bcrypt = require("bcrypt");
const DigiShop = require("../models/DigiShop");
const Event = require("../models/Event");
const GalleryPost = require("../models/GalleryPost");
const Listing = require("../models/Listing");
const { createNotification } = require("../services/notificationService");
const Order = require("../models/Order");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");

const privateFields =
  "-passwordHash -refreshTokens -emailVerifyToken -resetPasswordToken -resetPasswordExpires";

exports.getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select(privateFields).populate("kycId");
  return success(res, { user }, "Profile loaded");
});

exports.updateMe = asyncHandler(async (req, res) => {
  const updates = {};
  const allowed = ["name", "phone"];

  allowed.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  if (req.body.region !== undefined || req.body.city !== undefined) {
    updates.location = {
      region: req.body.region || "",
      city: req.body.city || "",
    };
  }

  if (req.fileUrls?.[0]) {
    updates.profilePhoto = req.fileUrls[0];
  }

  const user = await User.findByIdAndUpdate(req.user.id, updates, {
    new: true,
    runValidators: true,
  }).select(privateFields);

  return success(res, { user }, "Profile updated");
});

const profileForUser = async (user, options = {}) => {
  const includeOrders = typeof options === "boolean" ? options : Boolean(options.includeOrders);
  const viewerId = typeof options === "object" ? options.viewerId : null;
  const shop = await DigiShop.findOne({ ownerId: user._id }).lean();
  const [listings, events, gallery, followerCount, followingRecord, activeOrders] = await Promise.all([
    shop
      ? Listing.find({ shopId: shop._id, status: { $ne: "removed" } })
          .populate("shopId", "shopName slug rating totalReviews")
          .sort({ createdAt: -1 })
          .limit(12)
          .lean()
      : [],
    Event.find({ organizerId: user._id }).sort({ date: -1 }).limit(12).lean(),
    GalleryPost.find({ userId: user._id }).sort({ createdAt: -1 }).limit(12).lean(),
    User.countDocuments({ following: user._id }),
    viewerId ? User.exists({ _id: viewerId, following: user._id }) : null,
    includeOrders
      ? Order.find({
          $or: [{ buyerId: user._id }, ...(shop ? [{ shopId: shop._id }] : [])],
          status: { $in: ["pending", "paid", "processing", "shipped", "disputed"] },
        })
          .sort({ createdAt: -1 })
          .limit(8)
          .lean()
      : [],
  ]);

  return {
    user,
    activeOrders,
    events,
    followerCount,
    followingCount: user.following?.length || 0,
    gallery,
    isFollowing: Boolean(followingRecord),
    listings,
    shop,
  };
};

exports.getMyProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select(privateFields).lean();
  return success(res, await profileForUser(user, { includeOrders: true, viewerId: req.user.id }), "Profile loaded");
});

exports.getProfileByUsername = asyncHandler(async (req, res) => {
  const user = await User.findOne({ username: req.params.username.toLowerCase() })
    .select("name username profilePhoto location isKycVerified hasShop following createdAt")
    .lean();

  if (!user) {
    throw httpError(404, "User not found");
  }

  return success(res, await profileForUser(user), "Profile loaded");
});

exports.toggleFollow = asyncHandler(async (req, res) => {
  const target = await User.findOne({ username: req.params.username.toLowerCase() }).select("_id username");
  if (!target) throw httpError(404, "User not found");

  if (target._id.toString() === req.user.id) {
    throw httpError(400, "You cannot follow yourself");
  }

  const currentUser = await User.findById(req.user.id).select("following");
  const isFollowing = currentUser.following.some((id) => id.toString() === target._id.toString());

  if (isFollowing) {
    currentUser.following = currentUser.following.filter((id) => id.toString() !== target._id.toString());
  } else {
    currentUser.following.push(target._id);
  }

  await currentUser.save();

  const followerCount = await User.countDocuments({ following: target._id });
  if (!isFollowing) {
    await createNotification({
      userId: target._id,
      type: "system",
      title: "New follower",
      body: `${req.currentUser.name || req.user.username} started following you.`,
      link: `/profile/${req.user.username}`,
    });
  }

  return success(res, { following: !isFollowing, followerCount }, "Follow status updated");
});

exports.followStatus = asyncHandler(async (req, res) => {
  const target = await User.findOne({ username: req.params.username.toLowerCase() }).select("_id");
  if (!target) throw httpError(404, "User not found");

  const [followingRecord, followerCount] = await Promise.all([
    User.exists({ _id: req.user.id, following: target._id }),
    User.countDocuments({ following: target._id }),
  ]);

  return success(res, { following: Boolean(followingRecord), followerCount }, "Follow status loaded");
});

exports.changePassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select("+passwordHash +refreshTokens");

  const matches = await bcrypt.compare(req.body.currentPassword, user.passwordHash);

  if (!matches) {
    throw httpError(400, "Current password is incorrect");
  }

  user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
  user.refreshTokens = [];
  await user.save();

  return success(res, {}, "Password changed");
});

exports.getPublicProfile = asyncHandler(async (req, res) => {
  const user = await User.findOne({ username: req.params.username.toLowerCase() })
    .select("name username profilePhoto location isKycVerified hasShop following createdAt")
    .populate("kycId", "status");

  if (!user) {
    throw httpError(404, "User not found");
  }

  return success(res, { user }, "Public profile loaded");
});
