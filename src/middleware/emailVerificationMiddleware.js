const requireEmailVerified = (req, res, next) => {
  if (!req.user?.isEmailVerified) {
    return res.status(403).json({
      success: false,
      error: "Email verification required for this action",
    });
  }

  next();
};

module.exports = requireEmailVerified;
