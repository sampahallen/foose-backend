const mongoose = require("mongoose");
const { Schema } = mongoose;

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
    items: [
      {
        listingId: {
          type: Schema.Types.ObjectId,
          ref: "Listing",
        },
        title: String,
        price: Number,
        quantity: Number,
      },
    ],
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
    },
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
    paymentRef: String,
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
    escrowStatus: {
      type: String,
      enum: ["not_held", "held", "released", "refunded"],
      default: "held",
      index: true,
    },
    sellerAction: {
      type: String,
      enum: ["pending", "accepted", "shipped", "pickup_ready"],
      default: "pending",
      index: true,
    },
    sellerActionAt: Date,
    sellerActionDeadline: Date,
    sellerNote: {
      type: String,
      trim: true,
      default: "",
    },
    autoReleaseAt: Date,
    releasedAt: Date,
    buyerConfirmedAt: Date,
    recommendationAwardedAt: Date,
    delivery: {
      method: {
        type: String,
        enum: ["pickup", "delivery"],
      },
      fee: Number,
      address: {
        region: String,
        city: String,
        street: String,
      },
      trackingInfo: String,
    },
    disputeReason: String,
    disputeResolvedAt: Date,
  },
  { timestamps: true },
);

module.exports = mongoose.model("Order", orderSchema);
