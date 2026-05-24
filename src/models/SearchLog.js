const mongoose = require("mongoose");
const { Schema } = mongoose;

const searchLogSchema = new Schema(
  {
    query: {
      type: String,
      required: true,
      trim: true,
    },
    normalizedQuery: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
  },
  { timestamps: true },
);

searchLogSchema.index({ createdAt: -1 });
searchLogSchema.index({ normalizedQuery: 1, createdAt: -1 });

module.exports = mongoose.model("SearchLog", searchLogSchema);
