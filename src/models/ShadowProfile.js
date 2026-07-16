const mongoose = require("mongoose");
const { Schema } = mongoose;

const scoreMap = () => ({
  type: Map,
  of: Number,
  default: () => ({}),
});

const itemAffinitiesSchema = new Schema(
  {
    category: scoreMap(),
    color: scoreMap(),
    digishopId: scoreMap(),
    hashtags: scoreMap(),
    location: scoreMap(),
    size: scoreMap(),
  },
  { _id: false },
);

const finspoAffinitiesSchema = new Schema(
  {
    creatorId: scoreMap(),
    hashtags: scoreMap(),
  },
  { _id: false },
);

const shadowProfileSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    itemAffinities: {
      type: itemAffinitiesSchema,
      default: () => ({}),
    },
    finspoAffinities: {
      type: finspoAffinitiesSchema,
      default: () => ({}),
    },
    signalCounts: scoreMap(),
    lastSignalAt: Date,
  },
  { timestamps: true },
);

module.exports = mongoose.model("ShadowProfile", shadowProfileSchema);
