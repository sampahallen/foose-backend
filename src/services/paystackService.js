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

const initializeTransaction = async ({
  callbackUrl,
  currency = "GHS",
  email,
  amount,
  metadata,
  reference,
}) => {
  requirePaystackKey();

  const response = await paystackClient.post("/transaction/initialize", {
    callback_url: callbackUrl,
    email,
    amount,
    currency,
    metadata,
    reference,
  });

  return response.data.data;
};

const verifyTransaction = async (reference) => {
  requirePaystackKey();

  const response = await paystackClient.get(`/transaction/verify/${reference}`);
  return response.data.data;
};

const toInlinePayment = (transaction) => ({
  accessCode: transaction.access_code,
  provider: "paystack",
  reference: transaction.reference,
  status: "pending",
});

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

const createRefund = async ({
  amount,
  currency = "GHS",
  customerNote,
  merchantNote,
  transaction,
}) => {
  requirePaystackKey();

  const response = await paystackClient.post("/refund", {
    transaction,
    amount,
    currency,
    customer_note: customerNote,
    merchant_note: merchantNote,
  });

  return response.data.data;
};

const fetchRefund = async (refundId) => {
  requirePaystackKey();
  const response = await paystackClient.get(`/refund/${refundId}`);
  return response.data.data;
};

const listRefunds = async ({ currency, page = 1, perPage = 50, transaction }) => {
  requirePaystackKey();
  const response = await paystackClient.get("/refund", {
    params: {
      currency,
      page,
      perPage,
      transaction,
    },
  });
  return response.data.data;
};

const verifyWebhookSignature = (rawBody, signature) => {
  const secret = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!secret || typeof signature !== "string" || !signature) return false;

  const hash = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");

  const expected = Buffer.from(hash, "utf8");
  const received = Buffer.from(signature, "utf8");
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
};

module.exports = {
  createRefund,
  fetchRefund,
  initializeTransaction,
  toInlinePayment,
  verifyTransaction,
  initiateTransfer,
  verifyWebhookSignature,
  listRefunds,
};
