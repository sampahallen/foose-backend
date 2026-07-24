const mongoose = require("mongoose");

const { Schema } = mongoose;

const walletLedgerEntrySchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      immutable: true,
      index: true,
    },
    paymentTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "PaymentTransaction",
      immutable: true,
    },
    settlementId: {
      type: Schema.Types.ObjectId,
      ref: "Settlement",
      immutable: true,
    },
    entryType: {
      type: String,
      enum: [
        "escrow_hold",
        "escrow_release",
        "escrow_refund",
        "withdrawal",
        "adjustment",
      ],
      required: true,
      immutable: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
    },
    balanceDelta: {
      type: Number,
      default: 0,
      immutable: true,
    },
    escrowDelta: {
      type: Number,
      default: 0,
      immutable: true,
    },
    balanceAfter: {
      type: Number,
      min: 0,
      immutable: true,
    },
    escrowAfter: {
      type: Number,
      min: 0,
      immutable: true,
    },
    currency: {
      type: String,
      default: "GHS",
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
      immutable: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 240,
      unique: true,
      immutable: true,
      select: false,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
      immutable: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
      immutable: true,
      select: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

walletLedgerEntrySchema.index(
  { userId: 1, createdAt: -1 },
  { name: "wallet_ledger_user_created" },
);
walletLedgerEntrySchema.index(
  { orderId: 1, createdAt: 1 },
  { name: "wallet_ledger_order_created" },
);

module.exports = mongoose.model("WalletLedgerEntry", walletLedgerEntrySchema);
