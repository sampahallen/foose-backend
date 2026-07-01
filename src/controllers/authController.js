const crypto = require("crypto");
const bcrypt = require("bcrypt");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { softDeleteUser } = require("../utils/accountLifecycle");
const { issueTokens, verifyRefreshToken } = require("../utils/generateToken");
const { normalizePhone } = require("../utils/phone");
const { sendEmail } = require("../services/emailService");
const {
  appleAuthorizationUrl,
  clientCallbackUrl,
  findOrCreateOAuthUser,
  getAppleProfile,
  getGoogleProfile,
  googleAuthorizationUrl,
  clientUrl,
  publicApiUrl,
  readState,
} = require("../services/oauthService");

const EMAIL_VERIFY_TOKEN_TTL_MS = 15 * 60 * 1000;

const userFields = "-passwordHash -refreshTokens -emailVerifyToken -emailVerifyExpires -resetPasswordToken -resetPasswordExpires -authProviders";

const sendAuth = async (res, user, message, statusCode = 200) => {
  const tokens = issueTokens(user);
  user.refreshTokens = [...(user.refreshTokens || []), tokens.refreshToken];
  await user.save();

  const safeUser = await User.findById(user._id).select(userFields);
  return success(res, { user: safeUser, tokens }, message, statusCode);
};

const makeToken = () => crypto.randomBytes(32).toString("hex");

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

const verificationLink = (token) => `${publicApiUrl()}/api/auth/verify-email/${encodeURIComponent(token)}`;

const callbackUrlWithParams = (params) => `${clientCallbackUrl()}#${params.toString()}`;

const clientPathUrl = (path) => {
  const basePath = (process.env.CLIENT_BASE_PATH || "").trim().replace(/^\/?/, "/").replace(/\/$/, "");
  return `${clientUrl()}${basePath}${path}`;
};

const loginUrlWithParams = (params) => `${clientPathUrl("/")}#/login?${params.toString()}`;

const wantsBrowserRedirect = (req) => req.accepts(["html", "json"]) === "html";

const sendVerificationEmail = async (user) => {
  const emailVerifyToken = makeToken();
  user.emailVerifyExpires = new Date(Date.now() + EMAIL_VERIFY_TOKEN_TTL_MS);
  user.emailVerifyToken = hashToken(emailVerifyToken);
  await user.save();

  const link = verificationLink(emailVerifyToken);

  return sendEmail({
    to: user.email,
    subject: "Verify your Foose account",
    text: `Click this secure link to verify your Foose account and sign in. It expires in 15 minutes: ${link}`,
    html: `
      <p>Click the secure link below to verify your Foose account and sign in.</p>
      <p><a href="${link}">Verify and sign in</a></p>
      <p>This link expires in 15 minutes and can only be used once.</p>
    `,
  });
};

const sendAuthRedirect = async (res, user, redirectTarget = "/login") => {
  const tokens = issueTokens(user);
  user.refreshTokens = [...(user.refreshTokens || []), tokens.refreshToken];
  await user.save();

  const params = new URLSearchParams({
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn || "",
    redirect: redirectTarget,
    refreshToken: tokens.refreshToken,
  });

  return res.redirect(callbackUrlWithParams(params));
};

const sendOAuthRedirect = async (res, user, redirectTarget) => {
  const tokens = issueTokens(user);
  user.refreshTokens = [...(user.refreshTokens || []), tokens.refreshToken];
  await user.save();

  const params = new URLSearchParams({
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn || "",
    redirect: redirectTarget || "/",
    refreshToken: tokens.refreshToken,
  });

  return res.redirect(`${clientCallbackUrl()}#${params.toString()}`);
};

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
  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    username: normalizedUsername,
    passwordHash,
    phone: normalizePhone(phone),
    location,
  });

  await sendVerificationEmail(user);

  return success(res, { email: user.email }, "Check your inbox for a verification link", 201);
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

  const accountStatus = user.accountStatus || "active";

  if (accountStatus === "deleted") {
    throw httpError(410, "This account has been deleted");
  }

  if (accountStatus === "deactivated") {
    if (user.scheduledDeletionAt && user.scheduledDeletionAt <= new Date()) {
      await softDeleteUser(user);
      throw httpError(410, "This deactivated account has been deleted after 30 days");
    }

    user.isEmailVerified = false;
    await sendVerificationEmail(user);
    throw httpError(403, "Account reactivation required. We sent a fresh sign-in link to your inbox.");
  }

  if (!user.isEmailVerified) {
    await sendVerificationEmail(user);
    throw httpError(403, "Email verification required. We sent a fresh sign-in link to your inbox.");
  }

  return sendAuth(res, user, "Login successful");
});

exports.startGoogleOAuth = asyncHandler(async (req, res) => {
  return res.redirect(googleAuthorizationUrl(req.query.redirect));
});

exports.startAppleOAuth = asyncHandler(async (req, res) => {
  return res.redirect(appleAuthorizationUrl(req.query.redirect));
});

exports.googleCallback = asyncHandler(async (req, res) => {
  const redirectTarget = readState(req.query.state);
  const profile = await getGoogleProfile(req.query.code);
  const user = await findOrCreateOAuthUser(profile);
  return sendOAuthRedirect(res, user, redirectTarget);
});

exports.appleCallback = asyncHandler(async (req, res) => {
  const redirectTarget = readState(req.body.state || req.query.state);
  const profile = await getAppleProfile(req.body.code || req.query.code, req.body.user);
  const user = await findOrCreateOAuthUser(profile);
  return sendOAuthRedirect(res, user, redirectTarget);
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
  const user = await User.findOneAndUpdate(
    {
      emailVerifyExpires: { $gt: new Date() },
      emailVerifyToken: hashToken(req.params.token),
    },
    {
      $set: { accountStatus: "active", isEmailVerified: true },
      $unset: { deactivatedAt: "", emailVerifyExpires: "", emailVerifyToken: "", scheduledDeletionAt: "" },
    },
    { new: true },
  ).select("+refreshTokens");

  if (!user) {
    if (wantsBrowserRedirect(req)) {
      const params = new URLSearchParams({
        error: "Verification link is invalid or expired",
      });
      return res.redirect(loginUrlWithParams(params));
    }

    throw httpError(400, "Invalid email verification token");
  }

  if (wantsBrowserRedirect(req)) {
    const params = new URLSearchParams({
      email: user.email,
      verified: "1",
    });
    return res.redirect(loginUrlWithParams(params));
  }

  const tokens = issueTokens(user);
  user.refreshTokens = [...(user.refreshTokens || []), tokens.refreshToken];
  await user.save();

  const safeUser = await User.findById(user._id).select(userFields);
  return success(res, { user: safeUser, tokens }, "Email verified");
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
