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
    paymentMethod: String,
    escrowStatus: {
      type: String,
      enum: ["held", "released", "refunded"],
      default: "held",
      index: true,
    },
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
