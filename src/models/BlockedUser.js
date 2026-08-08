const mongoose = require("mongoose");
const { Schema } = mongoose;

const blockedUserSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    blockedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

blockedUserSchema.index({ userId: 1, blockedUserId: 1 }, { unique: true });

module.exports = mongoose.model("BlockedUser", blockedUserSchema);
