const mongoose = require("mongoose");
const { MAX_HASHTAG_LENGTH, normalizeHashtag } = require("../utils/hashtags");

const { Schema } = mongoose;

const hashtagSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      index: true,
      maxlength: MAX_HASHTAG_LENGTH,
      set: normalizeHashtag,
    },
    postCount: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },
    listingCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    finspoCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Hashtag", hashtagSchema);
