const mongoose = require("mongoose");
const { Schema } = mongoose;

const listingSchema = new Schema(
  {
    shopId: {
      type: Schema.Types.ObjectId,
      ref: "DigiShop",
      required: true,
      index: true,
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

listingSchema.index({ title: "text", brand: "text", description: "text" });

module.exports = mongoose.model("Listing", listingSchema);
