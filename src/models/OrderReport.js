const mongoose = require("mongoose");
const {
  ORDER_REPORT_CATEGORIES,
  ORDER_REPORT_OUTCOMES,
  ORDER_REPORT_STATUSES,
} = require("../constants/orderLifecycle");

const { Schema } = mongoose;

const MAX_EVIDENCE_SIZE = 5 * 1024 * 1024;
const isSafetyHoldSource = (report) =>
  ["legacy_migration", "system_payment_validation"].includes(
    report.source?.type,
  );

const evidenceSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1024,
      select: false,
      immutable: true,
    },
    mimetype: {
      type: String,
      enum: ["image/jpeg", "image/png", "image/webp"],
      required: true,
      immutable: true,
    },
    size: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_EVIDENCE_SIZE,
      immutable: true,
    },
    originalName: {
      type: String,
      trim: true,
      maxlength: 255,
      default: "",
      immutable: true,
    },
  },
  { _id: true },
);

const orderReportSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
      immutable: true,
    },
    buyerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      immutable: true,
    },
    shopId: {
      type: Schema.Types.ObjectId,
      ref: "DigiShop",
      required: true,
      index: true,
      immutable: true,
    },
    category: {
      type: String,
      enum: ORDER_REPORT_CATEGORIES,
      required: true,
      immutable: true,
      index: true,
    },
    affectedItemIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          immutable: true,
        },
      ],
      default: [],
      validate: {
        validator: function validateAffectedItems(value) {
          return (
            value.length <= 100 &&
            (isSafetyHoldSource(this) || value.length >= 1)
          );
        },
        message: "A report must reference between one and 100 order items",
      },
      immutable: true,
    },
    requestedOutcome: {
      type: String,
      enum: ORDER_REPORT_OUTCOMES,
      required: true,
      immutable: true,
    },
    detailedAccount: {
      type: String,
      required: true,
      trim: true,
      minlength: 20,
      maxlength: 5000,
      immutable: true,
    },
    evidence: {
      type: [evidenceSchema],
      default: [],
      validate: {
        validator: (value) => value.length <= 5,
        message: "A report can include at most five evidence images",
      },
      immutable: true,
    },
    declarationAccepted: {
      type: Boolean,
      required: true,
      immutable: true,
      validate: {
        validator(value) {
          return value === true || isSafetyHoldSource(this);
        },
        message: "The truthful-information declaration must be accepted",
      },
    },
    status: {
      type: String,
      enum: ORDER_REPORT_STATUSES,
      default: "submitted",
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
      index: true,
    },
    submittedAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
    frozenAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
    reviewStartedAt: Date,
    resolution: {
      awardedTo: {
        type: String,
        enum: ["buyer", "seller"],
      },
      resolverId: {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
      note: {
        type: String,
        trim: true,
        maxlength: 5000,
        default: "",
      },
      resolvedAt: Date,
    },
    source: {
      type: {
        type: String,
        enum: ["buyer", "legacy_migration", "system_payment_validation"],
        default: "buyer",
        immutable: true,
      },
      legacyOrderId: {
        type: Schema.Types.ObjectId,
        ref: "Order",
        immutable: true,
        select: false,
      },
    },
  },
  { timestamps: true },
);

orderReportSchema.index(
  { orderId: 1, isActive: 1 },
  {
    name: "order_report_one_active",
    partialFilterExpression: { isActive: true },
    unique: true,
  },
);
orderReportSchema.index(
  { status: 1, submittedAt: 1 },
  { name: "order_report_review_queue" },
);
orderReportSchema.index(
  { buyerId: 1, createdAt: -1 },
  { name: "order_report_buyer_created" },
);
orderReportSchema.index(
  { "source.legacyOrderId": 1 },
  {
    name: "order_report_legacy_order",
    partialFilterExpression: {
      "source.legacyOrderId": { $type: "objectId" },
    },
    unique: true,
  },
);

const stripPrivateStorageKeys = (_document, value) => {
  if (Array.isArray(value.evidence)) {
    value.evidence = value.evidence.map((asset) => {
      if (!asset || typeof asset !== "object") return asset;
      const { key: _privateKey, ...publicAsset } = asset;
      return publicAsset;
    });
  }
  if (value.source && typeof value.source === "object") {
    delete value.source.legacyOrderId;
  }
  return value;
};

orderReportSchema.set("toJSON", { transform: stripPrivateStorageKeys });
orderReportSchema.set("toObject", { transform: stripPrivateStorageKeys });

module.exports = mongoose.model("OrderReport", orderReportSchema);
