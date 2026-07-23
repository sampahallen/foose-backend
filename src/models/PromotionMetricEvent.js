const mongoose = require("mongoose");
const { Schema } = mongoose;

const promotionMetricEventSchema = new Schema(
  {
    promotionOrderId: { type: Schema.Types.ObjectId, ref: "PromotionOrder", required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    metric: { type: String, enum: ["impression", "click"], required: true },
    sessionId: { type: String, required: true, maxlength: 96 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

promotionMetricEventSchema.index(
  { promotionOrderId: 1, targetId: 1, metric: 1, sessionId: 1 },
  { unique: true },
);

module.exports = mongoose.model("PromotionMetricEvent", promotionMetricEventSchema);
