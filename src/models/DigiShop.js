const mongoose = require("mongoose");
const { Schema } = mongoose;

const digishopSchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    shopName: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    bio: {
      type: String,
      trim: true,
      default: "",
    },
    logoUrl: String,
    bannerUrl: String,
    category: {
      type: String,
      enum: ["retail", "wholesale", "both"],
      default: "both",
    },
    isLive: {
      type: Boolean,
      default: true,
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    totalReviews: {
      type: Number,
      default: 0,
    },
    socialLinks: {
      instagram: {
        type: String,
        trim: true,
        default: "",
      },
      whatsapp: {
        type: String,
        trim: true,
        default: "",
      },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("DigiShop", digishopSchema);
