const mongoose = require("mongoose");
const { MAX_HASHTAGS, normalizeHashtags } = require("../utils/hashtags");
const { Schema } = mongoose;

const listingSchema = new Schema(
  {
    shopId: {
      type: Schema.Types.ObjectId,
      ref: "DigiShop",
      required: true,
      index: true,
    },
    location: {
      city: {
        type: String,
        trim: true,
        default: "",
      },
      region: {
        type: String,
        trim: true,
        default: "",
      },
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    hashtags: {
      type: [String],
      default: [],
      index: true,
      set: normalizeHashtags,
      validate: [(value) => value.length <= MAX_HASHTAGS, `A listing can have max ${MAX_HASHTAGS} hashtags`],
    },
    category: {
      type: String,
      trim: true,
      index: true,
    },
    brand: {
      type: String,
      trim: true,
      default: "",
    },
    size: {
      type: String,
      trim: true,
      default: "",
    },
    gender: {
      type: String,
      enum: ["men", "women", "unisex", "kids"],
      index: true,
    },
    condition: {
      type: String,
      enum: ["excellent", "great", "good", "fair", "poor"],
      index: true,
    },
    color: {
      type: String,
      enum: [
        "beige",
        "black",
        "blue",
        "brown",
        "burgundy",
        "cream",
        "cyan",
        "gold",
        "green",
        "gray",
        "ivory",
        "khaki",
        "multi",
        "navy",
        "olive",
        "orange",
        "pink",
        "purple",
        "red",
        "silver",
        "teal",
        "turquoise",
        "violet",
        "white",
        "yellow",
      ],
      default: "multi",
      index: true,
    },
    type: {
      type: String,
      enum: ["retail", "wholesale"],
      required: true,
      index: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "GHS",
    },
    quantity: {
      type: Number,
      default: 1,
      min: 0,
    },
    bulkMinQty: Number,
    bulkWeight: String,
    volumeDiscounts: [
      {
        minQty: Number,
        pricePerUnit: Number,
      },
    ],
    images: {
      type: [String],
      default: [],
      validate: [(value) => value.length <= 6, "A listing can have max 6 images"],
    },
    promotionTags: {
      type: [String],
      default: [],
      index: true,
      set: (tags) =>
        (Array.isArray(tags) ? tags : [])
          .map((tag) => String(tag).trim().toLowerCase())
          .filter(Boolean),
    },
    promotionExpiresAt: {
      type: Date,
      index: true,
    },
    visibility: {
      type: String,
      enum: ["marketplace", "event"],
      default: "marketplace",
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "sold", "draft", "removed"],
      default: "active",
      index: true,
    },
    views: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

listingSchema.index({ title: "text", brand: "text", description: "text", hashtags: "text" });
listingSchema.index({ "location.region": 1, "location.city": 1, status: 1 });

module.exports = mongoose.model("Listing", listingSchema);
