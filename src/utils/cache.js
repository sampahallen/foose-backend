const { getRedis } = require("../config/redis");

const cacheAvailable = () => {
  const redis = getRedis();
  return redis?.isOpen ? redis : null;
};

const withCache = async (key, ttl, fetchFn) => {
  const redis = cacheAvailable();

  if (!redis) {
    return fetchFn();
  }

  try {
    const cached = await redis.get(key);
    if (cached !== null) return JSON.parse(cached);
  } catch (error) {
    console.warn(`Redis cache read failed for ${key}: ${error.message}`);
  }

  const data = await fetchFn();

  try {
    await redis.setEx(key, ttl, JSON.stringify(data));
  } catch (error) {
    console.warn(`Redis cache write failed for ${key}: ${error.message}`);
  }

  return data;
};

const invalidate = async (...keys) => {
  const redis = cacheAvailable();
  const cacheKeys = keys.flat().filter(Boolean);

  if (!redis || !cacheKeys.length) return;

  try {
    await redis.del(cacheKeys);
  } catch (error) {
    console.warn(`Redis cache invalidation failed: ${error.message}`);
  }
};

const invalidatePattern = async (pattern) => {
  const redis = cacheAvailable();
  if (!redis) return;

  try {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(keys);
  } catch (error) {
    console.warn(`Redis cache pattern invalidation failed: ${error.message}`);
  }
};

module.exports = {
  withCache,
  invalidate,
  invalidatePattern,
};
