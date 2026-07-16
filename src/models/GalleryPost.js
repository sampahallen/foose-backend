const mongoose = require("mongoose");
const { MAX_HASHTAGS, normalizeHashtags } = require("../utils/hashtags");
const { Schema } = mongoose;

const galleryPostSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    imageUrl: {
      type: String,
      required: true,
    },
    caption: {
      type: String,
      trim: true,
      default: "",
    },
    tags: {
      type: [String],
      default: [],
      set: normalizeHashtags,
      validate: [(value) => value.length <= MAX_HASHTAGS, `A Finspo post can have max ${MAX_HASHTAGS} hashtags`],
    },
    likes: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true },
);

module.exports = mongoose.model("GalleryPost", galleryPostSchema);
