const jwt = require("jsonwebtoken");

const accessSecret = () =>
  process.env.JWT_ACCESS_SECRET ||
  process.env.ACCESS_TOKEN_SECRET ||
  "development_access_secret";

const refreshSecret = () =>
  process.env.JWT_REFRESH_SECRET ||
  process.env.REFRESH_TOKEN_SECRET ||
  "development_refresh_secret";

const signAccessToken = (user) => {
  return jwt.sign(
    {
      id: user._id.toString(),
      hasShop: Boolean(user.hasShop),
      isKycVerified: Boolean(user.isKycVerified),
      role: user.role || "user",
    },
    accessSecret(),
    { expiresIn: process.env.JWT_ACCESS_EXPIRES || "15m" },
  );
};

const signRefreshToken = (user) => {
  return jwt.sign(
    {
      id: user._id.toString(),
      tokenVersion: Date.now(),
    },
    refreshSecret(),
    { expiresIn: process.env.JWT_REFRESH_EXPIRES || "7d" },
  );
};

const verifyAccessToken = (token) => jwt.verify(token, accessSecret());

const verifyRefreshToken = (token) => jwt.verify(token, refreshSecret());

const issueTokens = (user) => ({
  accessToken: signAccessToken(user),
  refreshToken: signRefreshToken(user),
  expiresIn: process.env.JWT_ACCESS_EXPIRES || "15m",
});

module.exports = {
  issueTokens,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
