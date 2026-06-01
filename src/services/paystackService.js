const crypto = require("crypto");
const axios = require("axios");

const paystackClient = axios.create({
  baseURL: "https://api.paystack.co",
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY || ""}`,
    "Content-Type": "application/json",
  },
});

const hasPaystackKey = () => Boolean(process.env.PAYSTACK_SECRET_KEY?.trim());

const requirePaystackKey = () => {
  if (!hasPaystackKey()) {
    throw new Error("PAYSTACK_SECRET_KEY is required to process Paystack payments");
  }
};

const initializeTransaction = async ({ callbackUrl, email, amount, metadata }) => {
  requirePaystackKey();

  const response = await paystackClient.post("/transaction/initialize", {
    callback_url: callbackUrl,
    email,
    amount,
    metadata,
  });

  return response.data.data;
};

const verifyTransaction = async (reference) => {
  requirePaystackKey();

  const response = await paystackClient.get(`/transaction/verify/${reference}`);
  return response.data.data;
};

const initiateTransfer = async ({ amount, recipient, reason }) => {
  if (!hasPaystackKey()) {
    return {
      status: "success",
      transfer_code: `mock_transfer_${Date.now()}`,
      amount,
      recipient,
      reason,
    };
  }

  const response = await paystackClient.post("/transfer", {
    source: "balance",
    amount,
    recipient,
    reason,
  });

  return response.data.data;
};

const verifyWebhookSignature = (rawBody, signature) => {
  if (!process.env.PAYSTACK_SECRET_KEY) return true;

  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");

  return hash === signature;
};

module.exports = {
  initializeTransaction,
  verifyTransaction,
  initiateTransfer,
  verifyWebhookSignature,
};
