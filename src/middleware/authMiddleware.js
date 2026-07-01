const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const { verifyAccessToken } = require("../utils/generateToken");

const auth = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      success: false,
      error: "Authorization token is required",
    });
  }

  let decoded;

  try {
    decoded = verifyAccessToken(token);
  } catch (error) {
    const message =
      error.name === "TokenExpiredError"
        ? "Access token has expired"
        : "Invalid access token";

    return res.status(401).json({
      success: false,
      error: message,
    });
  }

  const user = await User.findById(decoded.id).select(
    "_id name email username phone role hasShop isKycVerified wallet kycId accountStatus",
  );

  const accountStatus = user?.accountStatus || "active";

  if (!user || accountStatus !== "active") {
    return res.status(401).json({
      success: false,
      error: "User account is not active",
    });
  }

  req.user = {
    id: user._id.toString(),
    role: user.role,
    hasShop: Boolean(user.hasShop),
    isKycVerified: Boolean(user.isKycVerified),
    email: user.email,
    phone: user.phone,
    username: user.username,
  };
  req.currentUser = user;

  next();
});

module.exports = auth;
