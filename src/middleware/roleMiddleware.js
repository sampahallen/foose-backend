const forbid = (res, message) =>
  res.status(403).json({
    success: false,
    error: message,
  });

const isAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return forbid(res, "Admin access required");
  }

  next();
};

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
  isAdmin,
  hasShop,
  isKycVerified,
};
