const { createClient } = require("redis");

let client;

const connectRedis = async () => {
  if (!process.env.REDIS_URL) {
    console.warn("REDIS_URL not set; Redis features are disabled");
    return null;
  }

  if (client?.isOpen) return client;

  client = createClient({ url: process.env.REDIS_URL });
  client.on("error", (error) => {
    console.error("Redis error", error.message);
  });

  await client.connect();
  console.log("Redis connected");

  return client;
};

const getRedis = () => client;

module.exports = {
  connectRedis,
  getRedis,
};
