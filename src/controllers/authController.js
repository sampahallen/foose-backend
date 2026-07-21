const crypto = require("crypto");
const bcrypt = require("bcrypt");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { softDeleteUser } = require("../utils/accountLifecycle");
const { issueTokens, verifyRefreshToken } = require("../utils/generateToken");
const { normalizePhone } = require("../utils/phone");
const { sendEmail, sendPasswordResetEmail } = require("../services/emailService");
const { ensureShadowProfile } = require("../services/recommendationService");
const {
  rebuildUserSearchDocuments,
  runSearchSync,
  syncUserSearchDocument,
} = require("../services/searchIndexService");
const {
  appleAuthorizationUrl,
  clientCallbackUrl,
  findOrCreateOAuthUser,
  getAppleProfile,
  getGoogleProfile,
  googleAuthorizationUrl,
  clientUrl,
  readState,
} = require("../services/oauthService");
const {
  EMAIL_VERIFY_TOKEN_PATTERN,
  consumeEmailVerificationToken,
  emailVerificationLink,
  issueEmailVerificationToken,
} = require("../services/emailVerificationService");

const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const userFields = "-passwordHash -refreshTokens -emailVerifyToken -emailVerifyExpires -resetPasswordToken -resetPasswordExpires -authProviders";

const ensureRecommendationProfile = async (userId) => {
  try {
    await ensureShadowProfile(userId);
  } catch (error) {
    console.warn(`Shadow profile setup failed: ${error.message}`);
  }
};

const sendAuth = async (res, user, message, statusCode = 200) => {
  await ensureRecommendationProfile(user._id);
  const tokens = issueTokens(user);
  user.refreshTokens = [...(user.refreshTokens || []), tokens.refreshToken];
  await user.save();

  const safeUser = await User.findById(user._id).select(userFields);
  return success(res, { user: safeUser, tokens }, message, statusCode);
};

const passwordResetSigningSecret = () =>
  process.env.PASSWORD_RESET_SECRET ||
  process.env.JWT_ACCESS_SECRET ||
  process.env.ACCESS_TOKEN_SECRET ||
  "development_password_reset_secret";

const passwordResetSignature = ({ expiresAt, passwordHash, userId }) =>
  crypto
    .createHmac("sha256", passwordResetSigningSecret())
    .update(`${userId}.${expiresAt}.${passwordHash}`)
    .digest("base64url");

const makePasswordResetToken = (user) => {
  const userId = user._id.toString();
  const expiresAt = Date.now() + PASSWORD_RESET_TOKEN_TTL_MS;
  const signature = passwordResetSignature({ expiresAt, passwordHash: user.passwordHash, userId });
  return `${userId}.${expiresAt}.${signature}`;
};

const passwordResetLink = (token) => `${clientPathUrl("/")}#/reset-password/${encodeURIComponent(token)}`;

const safeTokenEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const findUserByPasswordResetToken = async (token) => {
  const [userId, expiresAtRaw, signature] = String(token || "").split(".");
  const expiresAt = Number(expiresAtRaw);

  if (!userId || !Number.isFinite(expiresAt) || !signature || expiresAt <= Date.now()) return null;

  const user = await User.findById(userId).select("+passwordHash +refreshTokens");
  if (!user || user.accountStatus === "deleted") return null;

  const expectedSignature = passwordResetSignature({ expiresAt, passwordHash: user.passwordHash, userId });
  return safeTokenEqual(signature, expectedSignature) ? user : null;
};

const callbackUrlWithParams = (params) => `${clientCallbackUrl()}#${params.toString()}`;

const clientPathUrl = (path) => {
  const basePath = (process.env.CLIENT_BASE_PATH || "").trim().replace(/^\/?/, "/").replace(/\/$/, "");
  return `${clientUrl()}${basePath}${path}`;
};

const loginUrlWithParams = (params) => `${clientPathUrl("/")}#/login?${params.toString()}`;

const wantsBrowserRedirect = (req) => req.accepts(["html", "json"]) === "html";

const sendVerificationEmail = async (user) => {
  const emailVerifyToken = await issueEmailVerificationToken(user);
  const link = emailVerificationLink(emailVerifyToken);

  return sendEmail({
    to: user.email,
    subject: "Verify your Foose account",
    text: `Click this secure link to verify your Foose email. Email verification is required for messaging, checkout, listing items, and opening a DigiShop. The link expires in 15 minutes: ${link}`,
    html: `
      <p>Click the secure link below to verify your Foose email.</p>
      <p><a href="${link}">Verify email</a></p>
      <p>Email verification is required for messaging, checkout, listing items, and opening a DigiShop.</p>
      <p>This link expires in 15 minutes and can only be used once.</p>
    `,
  });
};

const needsFreshEmailVerification = (user, now = Date.now()) => {
  if (user?.isEmailVerified) return false;
  const expiresAt = new Date(user?.emailVerifyExpires || 0).getTime();
  return !user?.emailVerifyToken || !Number.isFinite(expiresAt) || expiresAt <= now;
};

const refreshExpiredVerificationEmail = async (user) => {
  if (!needsFreshEmailVerification(user)) return;

  try {
    await sendVerificationEmail(user);
  } catch (error) {
    // Delivery problems must not turn valid credentials into a failed login.
    // The signed-in user can retry through the rate-limited resend endpoint.
    console.warn(`Verification email refresh failed: ${error.message}`);
  }
};

const sendAuthRedirect = async (res, user, redirectTarget = "/login") => {
  await ensureRecommendationProfile(user._id);
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
  await ensureRecommendationProfile(user._id);
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

  await ensureRecommendationProfile(user._id);
  await runSearchSync(`user:${user._id}:register`, () =>
    syncUserSearchDocument(user._id));
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
    await refreshExpiredVerificationEmail(user);
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
  await runSearchSync(`user:${user._id}:google-oauth`, () =>
    syncUserSearchDocument(user._id));
  return sendOAuthRedirect(res, user, redirectTarget);
});

exports.appleCallback = asyncHandler(async (req, res) => {
  const redirectTarget = readState(req.body.state || req.query.state);
  const profile = await getAppleProfile(req.body.code || req.query.code, req.body.user);
  const user = await findOrCreateOAuthUser(profile);
  await runSearchSync(`user:${user._id}:apple-oauth`, () =>
    syncUserSearchDocument(user._id));
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
  const user = await consumeEmailVerificationToken(req.params.token);

  if (!user) {
    if (wantsBrowserRedirect(req)) {
      const params = new URLSearchParams({
        error: "Verification link is invalid or expired",
      });
      return res.redirect(loginUrlWithParams(params));
    }

    throw httpError(400, "Invalid email verification token");
  }

  await runSearchSync(`user:${user._id}:activate`, () =>
    rebuildUserSearchDocuments(user._id));

  if (wantsBrowserRedirect(req)) {
    const params = new URLSearchParams({
      email: user.email,
      verified: "1",
    });
    return res.redirect(loginUrlWithParams(params));
  }

  const tokens = issueTokens(user);
  await ensureRecommendationProfile(user._id);
  user.refreshTokens = [...(user.refreshTokens || []), tokens.refreshToken];
  await user.save();

  const safeUser = await User.findById(user._id).select(userFields);
  return success(res, { user: safeUser, tokens }, "Email verified");
});

exports.verifyEmailFromClient = asyncHandler(async (req, res) => {
  const token = String(req.body?.token || "").trim().toLowerCase();
  if (!EMAIL_VERIFY_TOKEN_PATTERN.test(token)) {
    throw httpError(400, "Invalid email verification token");
  }

  const user = await consumeEmailVerificationToken(token);
  if (!user) {
    throw httpError(400, "Invalid or expired email verification token");
  }

  await runSearchSync(`user:${user._id}:activate`, () =>
    rebuildUserSearchDocuments(user._id));

  return success(res, { email: user.email }, "Email verified");
});

exports.resendVerificationEmail = asyncHandler(async (req, res) => {
  if (req.user.isEmailVerified) {
    return success(res, {}, "If verification is needed, a link has been sent");
  }

  const user = await User.findById(req.user.id);
  if (!user) throw httpError(401, "User account is not active");

  await sendVerificationEmail(user);
  return success(res, {}, "If verification is needed, a link has been sent");
});

exports.forgotPassword = asyncHandler(async (req, res) => {
  const user = await User.findOne({
    accountStatus: { $ne: "deleted" },
    email: req.body.email.toLowerCase(),
  }).select("+passwordHash");

  if (!user) {
    throw httpError(404, "No Foose account was found with that email address");
  }

  const resetToken = makePasswordResetToken(user);
  await sendPasswordResetEmail(user, passwordResetLink(resetToken));

  return success(res, {}, "Password reset link sent");
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const user = await findUserByPasswordResetToken(req.params.token);

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

exports.needsFreshEmailVerification = needsFreshEmailVerification;
