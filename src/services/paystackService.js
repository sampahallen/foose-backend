const crypto = require("crypto");
const axios = require("axios");

const paystackClient = axios.create({
  baseURL: "https://api.paystack.co",
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY || ""}`,
    "Content-Type": "application/json",
  },
});

const hasPaystackKey = () => Boolean(process.env.PAYSTACK_SECRET_KEY);

const initializeTransaction = async ({ email, amount, metadata }) => {
  if (!hasPaystackKey()) {
    const reference = `mock_${Date.now()}`;
    return {
      authorization_url: `${process.env.CLIENT_URL || "http://localhost:5473"}/payments/mock/${reference}`,
      access_code: "mock_access_code",
      reference,
    };
  }

  const response = await paystackClient.post("/transaction/initialize", {
    email,
    amount,
    metadata,
  });

  return response.data.data;
};

const verifyTransaction = async (reference) => {
  if (!hasPaystackKey() || reference.startsWith("mock_")) {
    return {
      status: "success",
      reference,
      amount: 0,
      paid_at: new Date().toISOString(),
    };
  }

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
