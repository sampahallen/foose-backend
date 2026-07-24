const mongoose = require("mongoose");
const {
  PAYMENT_RESERVATION_WINDOW_MS,
  PAYMENT_TRANSACTION_STATUSES,
} = require("../constants/orderLifecycle");

const { Schema } = mongoose;

const paymentTransactionSchema = new Schema(
  {
    buyerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    orderIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "Order",
          required: true,
        },
      ],
      default: [],
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: "A payment transaction must reference at least one order",
      },
    },
    provider: {
      type: String,
      enum: ["paystack"],
      default: "paystack",
      required: true,
    },
    providerReference: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      unique: true,
    },
    checkoutIdempotencyKey: {
      type: String,
      trim: true,
      maxlength: 200,
      select: false,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    refundedAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      default: "GHS",
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },
    status: {
      type: String,
      enum: PAYMENT_TRANSACTION_STATUSES,
      default: "pending",
      required: true,
      index: true,
    },
    channel: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
    },
    providerMetadata: {
      type: Schema.Types.Mixed,
      default: {},
      select: false,
    },
    processedEventKeys: {
      type: [String],
      default: [],
      select: false,
    },
    source: {
      type: String,
      enum: ["checkout", "legacy_migration"],
      default: "checkout",
      required: true,
    },
    legacyMigratedAt: Date,
    initializedAt: {
      type: Date,
      default: Date.now,
    },
    reservationExpiresAt: {
      type: Date,
      default: () => new Date(Date.now() + PAYMENT_RESERVATION_WINDOW_MS),
      index: true,
    },
    paidAt: Date,
    cancelledAt: Date,
    lateChargeWatchUntil: {
      type: Date,
      index: true,
    },
    failedAt: Date,
    attentionAt: Date,
    attentionReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    lastProviderEventAt: Date,
    reconciliationAttemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    reconciliationLastAttemptAt: Date,
    reconciliationNextAttemptAt: {
      type: Date,
      index: true,
    },
    reconciliationLastError: {
      type: String,
      maxlength: 500,
      default: "",
    },
    reconciliationClaim: {
      token: {
        type: String,
        select: false,
      },
      until: Date,
    },
  },
  { timestamps: true },
);

paymentTransactionSchema.index(
  { buyerId: 1, checkoutIdempotencyKey: 1 },
  {
    name: "payment_transaction_checkout_idempotency",
    partialFilterExpression: {
      checkoutIdempotencyKey: { $type: "string" },
    },
    unique: true,
  },
);
paymentTransactionSchema.index(
  { buyerId: 1, createdAt: -1 },
  { name: "payment_transaction_buyer_created" },
);
paymentTransactionSchema.index(
  { orderIds: 1 },
  { name: "payment_transaction_orders" },
);
paymentTransactionSchema.index(
  { status: 1, reconciliationNextAttemptAt: 1, "reconciliationClaim.until": 1 },
  { name: "payment_transaction_reconciliation_due" },
);
paymentTransactionSchema.index(
  { status: 1, reservationExpiresAt: 1 },
  { name: "payment_transaction_reservation_expiry" },
);

module.exports = mongoose.model("PaymentTransaction", paymentTransactionSchema);
