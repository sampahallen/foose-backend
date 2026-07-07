const { ROLE_GROUPS, hasAnyRole } = require("../constants/roles");

const forbid = (res, message) =>
  res.status(403).json({
    success: false,
    error: message,
  });

const requireAnyRole = (allowedRoles, message = "Staff access required") => (req, res, next) => {
  if (!hasAnyRole(req.user?.roles, allowedRoles)) {
    return forbid(res, message);
  }

  next();
};

const isSuperAdmin = requireAnyRole(ROLE_GROUPS.SUPER_ADMIN, "Super admin access required");
const isAdmin = isSuperAdmin;
const isStaff = requireAnyRole(ROLE_GROUPS.STAFF, "Staff access required");
const canReviewKyc = requireAnyRole(ROLE_GROUPS.KYC_REVIEW, "KYC reviewer access required");
const canModerateCommunity = requireAnyRole(
  ROLE_GROUPS.COMMUNITY_MODERATION,
  "Community moderator access required",
);
const canResolveDisputes = requireAnyRole(
  ROLE_GROUPS.DISPUTE_RESOLUTION,
  "Dispute resolver access required",
);

const hasShop = (req, res, next) => {
  if (!req.user?.hasShop) {
    return forbid(res, "DigiShop required");
  }

  next();
};

const isKycVerified = (req, res, next) => {
  if (!req.user?.isKycVerified) {
    return forbid(res, "KYC verification required to open a DigiShop");
  }

  next();
};

module.exports = {
  canModerateCommunity,
  canResolveDisputes,
  canReviewKyc,
  isAdmin,
  isSuperAdmin,
  isStaff,
  hasShop,
  isKycVerified,
  requireAnyRole,
};
