const mongoose = require("mongoose");
const {
  SETTLEMENT_STATUSES,
  SETTLEMENT_TRIGGERS,
  SETTLEMENT_TYPES,
} = require("../constants/orderLifecycle");

const { Schema } = mongoose;

const settlementSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    paymentTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "PaymentTransaction",
      index: true,
    },
    type: {
      type: String,
      enum: SETTLEMENT_TYPES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: SETTLEMENT_STATUSES,
      default: "pending",
      required: true,
      index: true,
    },
    trigger: {
      type: String,
      enum: SETTLEMENT_TRIGGERS,
      required: true,
    },
    destination: {
      type: String,
      enum: [
        "seller_wallet",
        "original_payment_method",
        "buyer_wallet_legacy",
      ],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    currency: {
      type: String,
      default: "GHS",
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 240,
      unique: true,
      select: false,
    },
    providerReference: {
      type: String,
      trim: true,
      maxlength: 180,
      default: "",
    },
    providerStatus: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
    },
    attemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    processingClaim: {
      token: {
        type: String,
        trim: true,
        maxlength: 160,
        select: false,
      },
      until: Date,
    },
    lastError: {
      code: {
        type: String,
        trim: true,
        maxlength: 120,
        default: "",
      },
      message: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: "",
      },
      at: Date,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
      select: false,
    },
    processedAt: Date,
    accountingAppliedAt: Date,
    failedAt: Date,
  },
  { timestamps: true },
);

settlementSchema.index(
  { status: 1, "processingClaim.until": 1, createdAt: 1 },
  { name: "settlement_processing_queue" },
);
settlementSchema.index(
  { orderId: 1, createdAt: -1 },
  { name: "settlement_order_created" },
);

module.exports = mongoose.model("Settlement", settlementSchema);
