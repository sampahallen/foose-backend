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
    commentCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
    },
    archivedAt: Date,
    archiveDeleteAt: Date,
  },
  { timestamps: true },
);

galleryPostSchema.index({ isArchived: 1, createdAt: -1 });
galleryPostSchema.index({ isArchived: 1, archivedAt: 1 });
galleryPostSchema.index({ userId: 1, isArchived: 1, archiveDeleteAt: 1 });
galleryPostSchema.index(
  { archiveDeleteAt: 1 },
  {
    expireAfterSeconds: 0,
    name: "gallery_archived_expiry_ttl",
    partialFilterExpression: { isArchived: true },
  },
);

module.exports = mongoose.model("GalleryPost", galleryPostSchema);
