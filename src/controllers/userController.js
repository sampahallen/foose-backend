const bcrypt = require("bcrypt");
const DigiShop = require("../models/DigiShop");
const Event = require("../models/Event");
const GalleryPost = require("../models/GalleryPost");
const Listing = require("../models/Listing");
const { createNotification } = require("../services/notificationService");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { deactivateUser, softDeleteUser } = require("../utils/accountLifecycle");
const { normalizePhone } = require("../utils/phone");
const { awardFinspoCreatorFollow, ensureShadowProfile } = require("../services/recommendationService");
const {
  rebuildUserSearchDocuments,
  runSearchSync,
} = require("../services/searchIndexService");

const privateFields =
  "-passwordHash -refreshTokens -emailVerifyToken -emailVerifyExpires -resetPasswordToken -resetPasswordExpires -deletedEmail -deletedUsername";
const activeAccountFilter = { $or: [{ accountStatus: "active" }, { accountStatus: { $exists: false } }] };

exports.getMe = asyncHandler(async (req, res) => {
  const [user] = await Promise.all([
    User.findById(req.user.id).select(privateFields).populate("kycId"),
    ensureShadowProfile(req.user.id).catch((error) => {
      console.warn(`Shadow profile setup failed: ${error.message}`);
    }),
  ]);
  return success(res, { user }, "Profile loaded");
});

exports.usernameAvailability = asyncHandler(async (req, res) => {
  const username = String(req.validated?.query?.username ?? req.query.username)
    .trim()
    .toLowerCase();
  const existingUser = await User.exists({
    username,
    _id: { $ne: req.user.id },
  });

  return success(
    res,
    { username, available: !existingUser },
    "Username availability checked",
  );
});

exports.updateMe = asyncHandler(async (req, res) => {
  const updates = {};
  const allowed = ["name", "phone", "bio"];

  allowed.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = String(req.body[field]).trim();
  });

  if (updates.phone !== undefined) updates.phone = normalizePhone(updates.phone);

  if (req.body.username !== undefined) {
    const username = String(req.body.username).trim().toLowerCase();
    const existing = await User.findOne({ username, _id: { $ne: req.user.id } }).select("_id");
    if (existing) throw httpError(409, "That username is already taken");
    updates.username = username;
  }

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

  if (user) {
    await runSearchSync(`user:${user._id}:profile-update`, () =>
      rebuildUserSearchDocuments(user._id));
  }

  return success(res, { user }, "Profile updated");
});

const profileForUser = async (user, options = {}) => {
  const viewerId = options.viewerId || null;
  const shop = await DigiShop.findOne({ ownerId: user._id }).lean();
  const [finspoCount, listingCount, eventCount, followerCount, followingCount, followingRecord] = await Promise.all([
    GalleryPost.countDocuments({ isArchived: { $ne: true }, userId: user._id }),
    shop
      ? Listing.countDocuments({ shopId: shop._id, status: "active", visibility: { $ne: "event" } })
      : 0,
    Event.countDocuments({ organizerId: user._id }),
    User.countDocuments({ ...activeAccountFilter, following: user._id }),
    User.countDocuments({ ...activeAccountFilter, _id: { $in: user.following || [] } }),
    viewerId ? User.exists({ _id: viewerId, following: user._id }) : null,
  ]);

  return {
    user,
    contentCounts: {
      events: eventCount,
      finspo: finspoCount,
      listings: listingCount,
    },
    followerCount,
    followingCount,
    isFollowing: Boolean(followingRecord),
    shop,
  };
};

exports.getMyProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select(privateFields).lean();
  return success(res, await profileForUser(user, { viewerId: req.user.id }), "Profile loaded");
});

exports.getProfileByUsername = asyncHandler(async (req, res) => {
  const user = await User.findOne({ ...activeAccountFilter, username: req.params.username.toLowerCase() })
    .select("name username bio profilePhoto location isKycVerified hasShop following createdAt")
    .lean();

  if (!user) {
    throw httpError(404, "User not found");
  }

  return success(res, await profileForUser(user, { viewerId: req.user?.id }), "Profile loaded");
});

const eventDateWithTime = (dateValue, timeValue, fallbackTime) => {
  const date = new Date(dateValue);
  if (Number.isNaN(date.valueOf())) return null;
  const match = String(timeValue || fallbackTime).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  date.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
  return date;
};

const serializeProfileEvent = (event, now = new Date()) => {
  const startsAt = event.startsAt ? new Date(event.startsAt) : eventDateWithTime(event.date, event.startTime, "00:00");
  const endsAt = event.endsAt ? new Date(event.endsAt) : eventDateWithTime(event.date, event.endTime, "23:59");
  const status = endsAt && endsAt < now ? "past" : startsAt && startsAt <= now ? "ongoing" : "upcoming";
  return { ...event, status };
};

exports.getProfileContent = asyncHandler(async (req, res) => {
  const username = req.validated?.params?.username ?? req.params.username.toLowerCase();
  const { limit, page, type } = req.validated?.query ?? req.query;
  const skip = (page - 1) * limit;
  const user = await User.findOne({ ...activeAccountFilter, username }).select("_id").lean();

  if (!user) throw httpError(404, "User not found");

  let items = [];
  let total = 0;

  if (type === "finspo") {
    const filter = { isArchived: { $ne: true }, userId: user._id };
    [items, total] = await Promise.all([
      GalleryPost.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      GalleryPost.countDocuments(filter),
    ]);
  } else if (type === "listings") {
    const shop = await DigiShop.findOne({ ownerId: user._id }).select("_id").lean();
    if (shop) {
      const filter = { shopId: shop._id, status: "active", visibility: { $ne: "event" } };
      [items, total] = await Promise.all([
        Listing.find(filter)
          .populate("shopId", "shopName slug rating totalReviews location logoUrl")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Listing.countDocuments(filter),
      ]);
    }
  } else {
    const filter = { organizerId: user._id };
    const [events, eventTotal] = await Promise.all([
      Event.find(filter).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Event.countDocuments(filter),
    ]);
    items = events.map((event) => serializeProfileEvent(event));
    total = eventTotal;
  }

  return success(res, {
    items,
    page,
    pages: Math.ceil(total / limit),
    total,
    type,
  }, "Profile content loaded");
});

exports.toggleFollow = asyncHandler(async (req, res) => {
  const target = await User.findOne({ ...activeAccountFilter, username: req.params.username.toLowerCase() }).select("_id username");
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
    await Promise.all([
      createNotification({
        userId: target._id,
        type: "system",
        title: "New follower",
        body: `${req.currentUser.name || req.user.username} started following you.`,
        link: `/profile/${req.user.username}`,
      }),
      awardFinspoCreatorFollow(req.user.id, target._id).catch((error) => {
        console.warn(`Follow recommendation signal failed: ${error.message}`);
      }),
    ]);
  }

  return success(res, { following: !isFollowing, followerCount }, "Follow status updated");
});

exports.followStatus = asyncHandler(async (req, res) => {
  const target = await User.findOne({ ...activeAccountFilter, username: req.params.username.toLowerCase() }).select("_id");
  if (!target) throw httpError(404, "User not found");

  const [followingRecord, followerCount] = await Promise.all([
    User.exists({ _id: req.user.id, following: target._id }),
    User.countDocuments({ following: target._id }),
  ]);

  return success(res, { following: Boolean(followingRecord), followerCount }, "Follow status loaded");
});

const connectionMemberFields = "_id name username profilePhoto isKycVerified hasShop";

exports.getProfileConnections = asyncHandler(async (req, res) => {
  const username = req.validated?.params?.username ?? req.params.username.toLowerCase();
  const { limit, page, type } = req.validated?.query ?? req.query;
  const target = await User.findOne({ ...activeAccountFilter, username }).select("_id username following").lean();
  if (!target) throw httpError(404, "User not found");

  const owner = Boolean(req.user?.id && target._id.toString() === req.user.id);
  if (!owner && Number(page) > 1) {
    throw httpError(403, `Only @${target.username} can see all ${type}`);
  }

  const connectionFilter = type === "followers"
    ? { ...activeAccountFilter, following: target._id }
    : { ...activeAccountFilter, _id: { $in: target.following || [] } };
  const total = await User.countDocuments(connectionFilter);
  const restricted = !owner && total > 30;
  const effectivePage = owner ? Number(page) : 1;
  const effectiveLimit = owner ? Number(limit) : 30;
  const items = await User.find(connectionFilter)
    .select(connectionMemberFields)
    .sort({ username: 1, _id: 1 })
    .skip((effectivePage - 1) * effectiveLimit)
    .limit(effectiveLimit)
    .lean();

  return success(res, {
    items,
    page: effectivePage,
    pages: restricted ? 1 : Math.max(1, Math.ceil(total / effectiveLimit)),
    restricted,
    total,
    type,
  }, "Profile connections loaded");
});

exports.unfollowUser = asyncHandler(async (req, res) => {
  const username = req.validated?.params?.username ?? req.params.username.toLowerCase();
  const target = await User.findOne({ ...activeAccountFilter, username }).select("_id").lean();
  if (!target) throw httpError(404, "User not found");
  if (target._id.toString() === req.user.id) throw httpError(400, "You cannot unfollow yourself");

  const currentUser = await User.findByIdAndUpdate(
    req.user.id,
    { $pull: { following: target._id } },
    { new: true },
  ).select("following").lean();
  const followingCount = await User.countDocuments({
    ...activeAccountFilter,
    _id: { $in: currentUser?.following || [] },
  });

  return success(res, { following: false, followingCount }, "User unfollowed");
});

exports.removeFollower = asyncHandler(async (req, res) => {
  const username = req.validated?.params?.username ?? req.params.username.toLowerCase();
  const follower = await User.findOne({ ...activeAccountFilter, username }).select("_id").lean();
  if (!follower) throw httpError(404, "User not found");
  if (follower._id.toString() === req.user.id) throw httpError(400, "You cannot remove yourself");

  const removedFollower = await User.findOneAndUpdate(
    { _id: follower._id, following: req.user.id },
    { $pull: { following: req.user.id } },
  ).select("_id").lean();
  const followerCount = await User.countDocuments({ ...activeAccountFilter, following: req.user.id });

  return success(res, { followerCount, removed: Boolean(removedFollower) }, "Follower removed");
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

exports.deactivateMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select("+refreshTokens");

  if (!user || user.accountStatus === "deleted") {
    throw httpError(404, "User not found");
  }

  await deactivateUser(user);

  return success(
    res,
    {
      scheduledDeletionAt: user.scheduledDeletionAt,
    },
    "Account deactivated. Log in and reverify within 30 days to reactivate it.",
  );
});

exports.deleteMe = asyncHandler(async (req, res) => {
  if (req.body.confirmation !== "DELETE") {
    throw httpError(400, "Type DELETE to confirm account deletion");
  }

  const user = await User.findById(req.user.id).select("+refreshTokens +deletedEmail +deletedUsername");

  if (!user || user.accountStatus === "deleted") {
    throw httpError(404, "User not found");
  }

  await softDeleteUser(user);

  return success(res, {}, "Account deleted");
});

exports.getPublicProfile = asyncHandler(async (req, res) => {
  const user = await User.findOne({ ...activeAccountFilter, username: req.params.username.toLowerCase() })
    .select("name username bio profilePhoto location isKycVerified hasShop following createdAt")
    .populate("kycId", "status");

  if (!user) {
    throw httpError(404, "User not found");
  }

  return success(res, { user }, "Public profile loaded");
});
