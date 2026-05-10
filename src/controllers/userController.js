const bcrypt = require("bcrypt");
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
  } else if (req.body.profilePhoto) {
    updates.profilePhoto = req.body.profilePhoto;
  }

  const user = await User.findByIdAndUpdate(req.user.id, updates, {
    new: true,
    runValidators: true,
  }).select(privateFields);

  return success(res, { user }, "Profile updated");
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
    .select("name username profilePhoto location isKycVerified hasShop createdAt")
    .populate("kycId", "status");

  if (!user) {
    throw httpError(404, "User not found");
  }

  return success(res, { user }, "Public profile loaded");
});
