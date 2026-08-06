const crypto = require("crypto");
const User = require("../models/User");
const { clientUrl } = require("./oauthService");

const EMAIL_CHANGE_TOKEN_TTL_MS = 30 * 60 * 1000;
const EMAIL_CHANGE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const makeEmailChangeToken = () => crypto.randomBytes(32).toString("hex");

const hashEmailChangeToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

const clientBasePath = () =>
  (process.env.CLIENT_BASE_PATH || "").trim().replace(/^\/?/, "/").replace(/\/$/, "");

const emailChangeConfirmationLink = (token) =>
  `${clientUrl()}${clientBasePath()}/#/confirm-email-change/${encodeURIComponent(token)}`;

const issueEmailChangeToken = async (user, newEmail) => {
  const token = makeEmailChangeToken();
  user.pendingEmail = newEmail;
  user.pendingEmailExpires = new Date(Date.now() + EMAIL_CHANGE_TOKEN_TTL_MS);
  user.pendingEmailToken = hashEmailChangeToken(token);
  await user.save();
  return token;
};

// Re-validates the unique email index atomically: if another account claimed
// `pendingEmail` after the change was requested, this update throws E11000
// instead of silently overwriting it.
const consumeEmailChangeToken = async (token) => {
  try {
    return await User.findOneAndUpdate(
      {
        pendingEmailExpires: { $gt: new Date() },
        pendingEmailToken: hashEmailChangeToken(token),
      },
      [
        { $set: { email: "$pendingEmail", isEmailVerified: true } },
        { $unset: ["pendingEmail", "pendingEmailToken", "pendingEmailExpires"] },
      ],
      { new: true },
    );
  } catch (error) {
    if (error?.code === 11000) {
      const conflictError = new Error("That email address is no longer available");
      conflictError.code = "EMAIL_TAKEN";
      throw conflictError;
    }
    throw error;
  }
};

module.exports = {
  EMAIL_CHANGE_TOKEN_PATTERN,
  consumeEmailChangeToken,
  emailChangeConfirmationLink,
  hashEmailChangeToken,
  issueEmailChangeToken,
};
