const crypto = require("crypto");
const User = require("../models/User");
const { clientUrl } = require("./oauthService");

const EMAIL_VERIFY_TOKEN_TTL_MS = 15 * 60 * 1000;
const EMAIL_VERIFY_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const makeEmailVerificationToken = () => crypto.randomBytes(32).toString("hex");

const hashEmailVerificationToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

const clientBasePath = () =>
  (process.env.CLIENT_BASE_PATH || "").trim().replace(/^\/?/, "/").replace(/\/$/, "");

const emailVerificationLink = (token) =>
  `${clientUrl()}${clientBasePath()}/#/verify-email/${encodeURIComponent(token)}`;

const issueEmailVerificationToken = async (user) => {
  const token = makeEmailVerificationToken();
  user.emailVerifyExpires = new Date(Date.now() + EMAIL_VERIFY_TOKEN_TTL_MS);
  user.emailVerifyToken = hashEmailVerificationToken(token);
  await user.save();
  return token;
};

const consumeEmailVerificationToken = (token) =>
  User.findOneAndUpdate(
    {
      emailVerifyExpires: { $gt: new Date() },
      emailVerifyToken: hashEmailVerificationToken(token),
    },
    {
      $set: { accountStatus: "active", isEmailVerified: true },
      $unset: { deactivatedAt: "", emailVerifyExpires: "", emailVerifyToken: "", scheduledDeletionAt: "" },
    },
    { new: true },
  ).select("+refreshTokens");

module.exports = {
  EMAIL_VERIFY_TOKEN_PATTERN,
  consumeEmailVerificationToken,
  emailVerificationLink,
  hashEmailVerificationToken,
  issueEmailVerificationToken,
};
