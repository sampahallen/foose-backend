const auth = require("./authMiddleware");

const optionalAuth = (req, res, next) => {
  const [scheme, token] = String(req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) return next();
  return auth(req, res, next);
};

module.exports = optionalAuth;
