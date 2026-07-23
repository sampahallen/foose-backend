const mongoose = require("mongoose");
const { Schema } = mongoose;

const promotionItemSchema = new Schema(
  {
    targetId: { type: Schema.Types.ObjectId, required: true },
    startsAt: Date,
    endsAt: Date,
    impressions: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const promotionOrderSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    targetType: { type: String, enum: ["listing", "event"], required: true, index: true },
    tier: {
      type: String,
      enum: ["quick_boost", "weekend_push", "top_pick", "homepage_feature"],
      required: true,
    },
    unitAmount: { type: Number, required: true, min: 1 },
    totalAmount: { type: Number, required: true, min: 1 },
    currency: { type: String, default: "GHS" },
    durationHours: { type: Number, required: true, min: 1 },
    provider: { type: String, default: "paystack" },
    paymentReference: { type: String, required: true, unique: true, index: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "processing", "paid", "failed"],
      default: "pending",
      index: true,
    },
    paidAt: Date,
    fulfilledAt: Date,
    items: { type: [promotionItemSchema], default: [] },
  },
  { timestamps: true },
);

promotionOrderSchema.index({ "items.targetId": 1, paymentStatus: 1, "items.startsAt": 1, "items.endsAt": 1 });

module.exports = mongoose.model("PromotionOrder", promotionOrderSchema);
