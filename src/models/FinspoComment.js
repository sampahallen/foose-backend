const mongoose = require("mongoose");

const { Schema } = mongoose;

const finspoCommentSchema = new Schema(
  {
    postId: {
      type: Schema.Types.ObjectId,
      ref: "GalleryPost",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    rootCommentId: {
      type: Schema.Types.ObjectId,
      ref: "FinspoComment",
      default: null,
    },
    replyToCommentId: {
      type: Schema.Types.ObjectId,
      ref: "FinspoComment",
      default: null,
    },
    replyToUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    likes: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
    replyCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    postDeleteAt: Date,
  },
  { timestamps: true },
);

finspoCommentSchema.index({ postId: 1, rootCommentId: 1, createdAt: -1 });
finspoCommentSchema.index({ rootCommentId: 1, createdAt: 1 });
finspoCommentSchema.index(
  { postDeleteAt: 1 },
  {
    expireAfterSeconds: 0,
    name: "finspo_comment_post_expiry_ttl",
  },
);

module.exports = mongoose.model("FinspoComment", finspoCommentSchema);
