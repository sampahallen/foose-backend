const crypto = require("crypto");
const bcrypt = require("bcrypt");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { issueTokens, verifyRefreshToken } = require("../utils/generateToken");
const { sendEmail } = require("../services/emailService");

const userFields = "-passwordHash -refreshTokens -emailVerifyToken -resetPasswordToken -resetPasswordExpires";

const sendAuth = async (res, user, message, statusCode = 200) => {
  const tokens = issueTokens(user);
  user.refreshTokens = [...(user.refreshTokens || []), tokens.refreshToken];
  await user.save();

  const safeUser = await User.findById(user._id).select(userFields);
  return success(res, { user: safeUser, tokens }, message, statusCode);
};

const makeToken = () => crypto.randomBytes(32).toString("hex");

exports.register = asyncHandler(async (req, res) => {
  const { name, email, username, password, phone, location } = req.body;
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = username.trim().toLowerCase();

  const exists = await User.findOne({
    $or: [{ email: normalizedEmail }, { username: normalizedUsername }],
  });

  if (exists) {
    throw httpError(409, "A user with that email or username already exists");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const emailVerifyToken = makeToken();

  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    username: normalizedUsername,
    passwordHash,
    phone,
    location,
    emailVerifyToken,
  });

  await sendEmail({
    to: user.email,
    subject: "Verify your Foose account",
    text: `Use this token to verify your account: ${emailVerifyToken}`,
  });

  return sendAuth(res, user, "Registration successful", 201);
});

exports.login = asyncHandler(async (req, res) => {
  const { identifier, email, username, password } = req.body;
  const loginId = String(identifier || email || username || "").trim().toLowerCase();

  const user = await User.findOne({
    $or: [{ email: loginId }, { username: loginId }],
  }).select("+passwordHash +refreshTokens");

  if (!user) {
    throw httpError(401, "Invalid credentials");
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);

  if (!passwordMatches) {
    throw httpError(401, "Invalid credentials");
  }

  return sendAuth(res, user, "Login successful");
});

exports.refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw httpError(401, "Invalid refresh token");
  }

  const user = await User.findById(decoded.id).select("+refreshTokens");

  if (!user || !user.refreshTokens.includes(refreshToken)) {
    throw httpError(401, "Invalid refresh token");
  }

  const tokens = issueTokens(user);
  user.refreshTokens = user.refreshTokens
    .filter((token) => token !== refreshToken)
    .concat(tokens.refreshToken);
  await user.save();

  const safeUser = await User.findById(user._id).select(userFields);
  return success(res, { user: safeUser, tokens }, "Token refreshed");
});

exports.logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  const user = await User.findById(req.user.id).select("+refreshTokens");

  if (user && refreshToken) {
    user.refreshTokens = user.refreshTokens.filter((token) => token !== refreshToken);
    await user.save();
  }

  return success(res, {}, "Logged out");
});

exports.verifyEmail = asyncHandler(async (req, res) => {
  const user = await User.findOne({ emailVerifyToken: req.params.token });

  if (!user) {
    throw httpError(400, "Invalid email verification token");
  }

  user.isEmailVerified = true;
  user.emailVerifyToken = undefined;
  await user.save();

  return success(res, { isEmailVerified: true }, "Email verified");
});

exports.forgotPassword = asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase() });

  if (user) {
    const resetToken = makeToken();
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();

    await sendEmail({
      to: user.email,
      subject: "Reset your ThriftGH password",
      text: `Use this token to reset your password: ${resetToken}`,
    });
  }

  return success(res, {}, "If the email exists, a reset link has been sent");
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const user = await User.findOne({
    resetPasswordToken: req.params.token,
    resetPasswordExpires: { $gt: new Date() },
  }).select("+passwordHash");

  if (!user) {
    throw httpError(400, "Invalid or expired reset token");
  }

  user.passwordHash = await bcrypt.hash(req.body.password, 12);
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  user.refreshTokens = [];
  await user.save();

  return success(res, {}, "Password reset successful");
});
