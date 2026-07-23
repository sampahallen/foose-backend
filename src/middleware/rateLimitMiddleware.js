const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { getRedis } = require("../config/redis");

const redisStore = () => {
  const redis = getRedis();

  if (!redis?.isOpen) return undefined;

  return new RedisStore({
    sendCommand: (...args) => redis.sendCommand(args),
  });
};

const createLimiter = (options) =>
  rateLimit({
    ...options,
    store: redisStore(),
  });

const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many auth requests. Please try again later.",
  },
});

const generalLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Please try again later.",
  },
});

const kycLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many KYC submissions. Please try again later.",
  },
});

const verificationEmailLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many verification email requests. Please try again later.",
  },
});

const promotionMetricLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many promotion analytics requests. Please try again later." },
});

module.exports = {
  authLimiter,
  generalLimiter,
  kycLimiter,
  promotionMetricLimiter,
  verificationEmailLimiter,
};
