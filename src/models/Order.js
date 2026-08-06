const mongoose = require("mongoose");
const {
  FULFILLMENT_STATUSES,
  ORDER_SETTLEMENT_STATUSES,
} = require("../constants/orderLifecycle");
const { DELIVERY_METHODS } = require("../constants/delivery");

const { Schema } = mongoose;

const MAX_PRIVATE_IMAGE_SIZE = 5 * 1024 * 1024;

const orderItemSchema = new Schema(
  {
    listingId: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
    },
    title: {
      type: String,
      trim: true,
      default: "",
    },
    price: {
      type: Number,
      min: 0,
    },
    quantity: {
      type: Number,
      min: 1,
      default: 1,
    },
  },
  { _id: true },
);

const privateImageSchema = new Schema(
  {
    key: {
      type: String,
      trim: true,
      maxlength: 1024,
      select: false,
    },
    mimetype: {
      type: String,
      enum: ["image/jpeg", "image/png", "image/webp"],
    },
    size: {
      type: Number,
      min: 1,
      max: MAX_PRIVATE_IMAGE_SIZE,
    },
    originalName: {
      type: String,
      trim: true,
      maxlength: 255,
      default: "",
    },
    // Temporary compatibility for old/public upload records. New uploads store only
    // the private key and are exposed through short-lived signed URLs.
    url: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false },
);

const defaultFulfillmentStatus = function defaultFulfillmentStatus() {
  if (["cancelled", "refunded"].includes(this.status)) return "cancelled";
  if (this.status === "delivered") return "completed";
  if (this.sellerAction === "shipped" || this.status === "shipped") return "in_transit";
  if (this.sellerAction === "pickup_ready") return "ready_for_pickup";
  return "awaiting_seller";
};

const defaultSettlementStatus = function defaultSettlementStatus() {
  if (this.paymentMethod === "cash_on_pickup" || this.paymentStatus === "cash_on_pickup") {
    if (this.status === "delivered") return "cash_collected";
    if (["cancelled", "refunded"].includes(this.status)) return "void";
    return "cash_due";
  }

  if (this.paymentStatus === "refunded" || this.escrowStatus === "refunded") return "refunded";
  if (this.escrowStatus === "released") return "released";
  if (this.paymentStatus === "paid" || this.escrowStatus === "held") return "held";
  if (this.status === "cancelled") return "void";
  return "payment_pending";
};

const orderSchema = new Schema(
  {
    buyerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    shopId: {
      type: Schema.Types.ObjectId,
      ref: "DigiShop",
      required: true,
      index: true,
    },
    settlementSellerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    items: {
      type: [orderItemSchema],
      default: [],
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: "An order must contain at least one item",
      },
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    subtotalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    deliveryFee: {
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

    // Legacy state fields remain readable for one compatibility release. All new
    // lifecycle writes must use fulfillmentStatus and settlementStatus.
    status: {
      type: String,
      enum: [
        "pending",
        "paid",
        "processing",
        "shipped",
        "delivered",
        "disputed",
        "cancelled",
        "refunded",
      ],
      default: "pending",
      index: true,
    },
    sellerAction: {
      type: String,
      enum: ["pending", "accepted", "shipped", "pickup_ready"],
      default: "pending",
      index: true,
    },
    escrowStatus: {
      type: String,
      enum: ["not_held", "held", "released", "refunded"],
      default: "not_held",
      index: true,
    },

    fulfillmentStatus: {
      type: String,
      enum: FULFILLMENT_STATUSES,
      default: defaultFulfillmentStatus,
      required: true,
      index: true,
    },
    settlementStatus: {
      type: String,
      enum: ORDER_SETTLEMENT_STATUSES,
      default: defaultSettlementStatus,
      required: true,
      index: true,
    },
    settlementExplanation: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    paymentTransactionId: {
      type: Schema.Types.ObjectId,
      ref: "PaymentTransaction",
      index: true,
    },
    checkoutIdempotencyKey: {
      type: String,
      trim: true,
      maxlength: 200,
      select: false,
    },
    checkoutRequestHash: {
      type: String,
      trim: true,
      minlength: 64,
      maxlength: 64,
      select: false,
    },
    checkoutAnchor: {
      type: Boolean,
      default: false,
      select: false,
    },
    activeReportId: {
      type: Schema.Types.ObjectId,
      ref: "OrderReport",
      index: true,
    },
    reportResolution: {
      awardedTo: {
        type: String,
        enum: ["buyer", "seller"],
      },
      resolvedAt: Date,
    },

    paymentRef: {
      type: String,
      trim: true,
      maxlength: 180,
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ["paystack_mock", "paystack", "cash_on_pickup"],
      default: "paystack_mock",
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "cash_on_pickup", "refunded"],
      default: "unpaid",
      index: true,
    },

    paidAt: Date,
    sellerActionAt: Date,
    sellerActionDeadline: Date,
    readyAt: Date,
    pickupExpiresAt: Date,
    sentAt: Date,
    deliveryReleaseAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    inventoryRestoredAt: Date,
    settledAt: Date,
    settlementFrozenAt: Date,
    workflowDeadlineAt: {
      type: Date,
      index: true,
    },
    sellerDeadlineNotifiedAt: Date,
    sellerDeadlineNotificationInAppAt: Date,
    sellerDeadlineNotificationEmailAt: Date,
    sellerDeadlineNotificationAttemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    sellerDeadlineNotificationLastError: {
      type: String,
      maxlength: 500,
      default: "",
    },
    sellerDeadlineNotificationClaim: {
      token: { type: String, select: false },
      until: Date,
    },
    pickupExpiryNotifiedAt: Date,
    pickupExpiryNotificationInAppAt: Date,
    pickupExpiryNotificationEmailAt: Date,
    pickupExpiryNotificationAttemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    pickupExpiryNotificationLastError: {
      type: String,
      maxlength: 500,
      default: "",
    },
    pickupExpiryNotificationClaim: {
      token: { type: String, select: false },
      until: Date,
    },

    checkoutCancelledAt: Date,
    autoReleaseAt: Date,
    releasedAt: Date,
    buyerConfirmedAt: Date,
    recommendationAwardedAt: Date,
    disputeResolvedAt: Date,

    sellerNote: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    delivery: {
      method: {
        type: String,
        enum: DELIVERY_METHODS,
      },
      company: {
        type: String,
        trim: true,
        maxlength: 160,
        default: "",
      },
      fee: {
        type: Number,
        min: 0,
      },
      destination: {
        recipientName: {
          type: String,
          trim: true,
          maxlength: 160,
          default: "",
        },
        recipientPhone: {
          type: String,
          trim: true,
          maxlength: 40,
          default: "",
        },
        region: {
          type: String,
          trim: true,
          maxlength: 120,
          default: "",
        },
        town: {
          type: String,
          trim: true,
          maxlength: 160,
          default: "",
        },
        preferredTerminal: {
          type: String,
          trim: true,
          maxlength: 240,
          default: "",
        },
      },
      transit: {
        serviceName: {
          type: String,
          trim: true,
          maxlength: 160,
          default: "",
        },
        driverPhone: {
          type: String,
          trim: true,
          maxlength: 40,
          default: "",
        },
        parcelNumber: {
          type: String,
          trim: true,
          maxlength: 120,
          default: "",
        },
        cargoTrackingNumber: {
          type: String,
          trim: true,
          maxlength: 120,
          default: "",
        },
        billImage: {
          type: privateImageSchema,
          default: undefined,
        },
      },

      // Legacy delivery input retained while old clients are phased out.
      address: {
        region: String,
        city: String,
        street: String,
      },
      trackingInfo: String,
    },

    workerClaim: {
      token: {
        type: String,
        trim: true,
        maxlength: 160,
        select: false,
      },
      until: Date,
      failureCount: {
        type: Number,
        min: 0,
        default: 0,
      },
      lastError: {
        type: String,
        trim: true,
        maxlength: 500,
        default: "",
      },
    },
    checkoutInitializationClaim: {
      token: {
        type: String,
        trim: true,
        maxlength: 160,
        select: false,
      },
      until: Date,
    },
    lifecycleMigration: {
      version: {
        type: Number,
        min: 1,
      },
      migratedAt: Date,
      requiresManualReview: {
        type: Boolean,
        default: false,
      },
      note: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: "",
      },
    },

    // Legacy dispute fields are retained for historical display only.
    disputeReason: String,
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  },
);

orderSchema.index(
  { buyerId: 1, fulfillmentStatus: 1, createdAt: -1 },
  { name: "order_buyer_fulfillment_created" },
);
orderSchema.index(
  { shopId: 1, fulfillmentStatus: 1, createdAt: -1 },
  { name: "order_shop_fulfillment_created" },
);
orderSchema.index(
  { settlementStatus: 1, pickupExpiresAt: 1, "workerClaim.until": 1 },
  { name: "order_pickup_deadline_worker" },
);
orderSchema.index(
  { settlementStatus: 1, deliveryReleaseAt: 1, "workerClaim.until": 1 },
  { name: "order_delivery_deadline_worker" },
);
orderSchema.index(
  { fulfillmentStatus: 1, sellerActionDeadline: 1 },
  { name: "order_seller_deadline" },
);
orderSchema.index(
  { activeReportId: 1, settlementStatus: 1 },
  { name: "order_report_settlement" },
);
orderSchema.index(
  { buyerId: 1, checkoutIdempotencyKey: 1, shopId: 1 },
  {
    name: "order_checkout_idempotency",
    partialFilterExpression: {
      checkoutIdempotencyKey: { $type: "string" },
    },
    unique: true,
  },
);
orderSchema.index(
  { buyerId: 1, checkoutIdempotencyKey: 1 },
  {
    name: "order_checkout_global_anchor",
    partialFilterExpression: {
      checkoutAnchor: true,
      checkoutIdempotencyKey: { $type: "string" },
    },
    unique: true,
  },
);

module.exports = mongoose.model("Order", orderSchema);
