const DEACTIVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const {
  removeUserSearchDocuments,
  runSearchSync,
} = require("../services/searchIndexService");

const deletionUsername = (user) => `deleted.${user._id.toString().slice(-12)}`;

const deletionEmail = (user) => `deleted+${user._id}.${Date.now()}@deleted.local`;

const deactivateUser = async (user) => {
  const now = new Date();
  user.accountStatus = "deactivated";
  user.deactivatedAt = now;
  user.scheduledDeletionAt = new Date(now.getTime() + DEACTIVATION_RETENTION_MS);
  user.isEmailVerified = false;
  user.emailVerifyToken = undefined;
  user.emailVerifyExpires = undefined;
  user.refreshTokens = [];
  await user.save();
  await runSearchSync(`user:${user._id}:deactivate`, () =>
    removeUserSearchDocuments(user._id));
  return user;
};

const softDeleteUser = async (user) => {
  const originalEmail = user.email;
  const originalUsername = user.username;

  user.accountStatus = "deleted";
  user.deletedAt = new Date();
  user.deletedEmail = originalEmail;
  user.deletedUsername = originalUsername;
  user.email = deletionEmail(user);
  user.username = deletionUsername(user);
  user.name = "Deleted user";
  user.bio = "";
  user.phone = "";
  user.profilePhoto = undefined;
  user.following = [];
  user.isEmailVerified = false;
  user.isKycVerified = false;
  user.emailVerifyToken = undefined;
  user.emailVerifyExpires = undefined;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  user.refreshTokens = [];
  await user.save();
  await runSearchSync(`user:${user._id}:delete`, () =>
    removeUserSearchDocuments(user._id));
  const ShadowProfile = require("../models/ShadowProfile");
  await ShadowProfile.deleteOne({ userId: user._id });
  return user;
};

const softDeleteExpiredDeactivatedUsers = async ({ limit = 100 } = {}) => {
  const User = require("../models/User");
  const expiredUsers = await User.find({
    accountStatus: "deactivated",
    scheduledDeletionAt: { $lte: new Date() },
  })
    .select("+refreshTokens +deletedEmail +deletedUsername")
    .limit(limit);

  for (const user of expiredUsers) {
    await softDeleteUser(user);
  }

  return expiredUsers.length;
};

const startAccountLifecycleCleanup = () => {
  const runCleanup = async () => {
    try {
      const deletedCount = await softDeleteExpiredDeactivatedUsers();
      if (deletedCount > 0) {
        console.log(`Soft deleted ${deletedCount} expired deactivated account(s)`);
      }
    } catch (error) {
      console.error("Account lifecycle cleanup failed:", error.message);
    }
  };

  void runCleanup();
  const timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  timer.unref?.();
  return timer;
};

module.exports = {
  DEACTIVATION_RETENTION_MS,
  deactivateUser,
  softDeleteExpiredDeactivatedUsers,
  softDeleteUser,
  startAccountLifecycleCleanup,
};
