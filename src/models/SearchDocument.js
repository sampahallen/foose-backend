const mongoose = require("mongoose");

const { Schema } = mongoose;

const SEARCH_SOURCE_TYPES = ["item", "finspo", "event", "user"];

const searchDocumentSchema = new Schema(
  {
    sourceType: {
      type: String,
      enum: SEARCH_SOURCE_TYPES,
      required: true,
    },
    sourceId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    ownerId: Schema.Types.ObjectId,
    shopId: Schema.Types.ObjectId,
    primaryText: { type: String, trim: true, default: "" },
    primaryNormalized: { type: String, trim: true, lowercase: true, default: "" },
    username: { type: String, trim: true, lowercase: true, default: "" },
    shopName: { type: String, trim: true, default: "" },
    shopNameNormalized: { type: String, trim: true, lowercase: true, default: "" },
    keywords: { type: [String], default: [] },
    bodyText: { type: String, trim: true, default: "" },
    hashtags: { type: [String], default: [] },
    autocompleteTokens: { type: [String], default: [] },
    publishedAt: { type: Date, default: Date.now },
    expiresAt: Date,
    sourceUpdatedAt: Date,
    rebuildGeneration: { type: String, default: "" },
  },
  { timestamps: true },
);

searchDocumentSchema.index(
  { sourceType: 1, sourceId: 1 },
  { name: "search_source_unique", unique: true },
);
searchDocumentSchema.index(
  {
    hashtags: "text",
    username: "text",
    primaryText: "text",
    shopName: "text",
    keywords: "text",
    bodyText: "text",
  },
  {
    default_language: "none",
    name: "search_weighted_text",
    weights: {
      hashtags: 16,
      username: 16,
      primaryText: 12,
      shopName: 12,
      keywords: 6,
      bodyText: 2,
    },
  },
);
searchDocumentSchema.index(
  { autocompleteTokens: 1, sourceType: 1, publishedAt: -1 },
  { name: "search_autocomplete_prefix" },
);
searchDocumentSchema.index(
  { hashtags: 1, sourceType: 1, publishedAt: -1 },
  { name: "search_hashtag_type_date" },
);
searchDocumentSchema.index(
  { sourceType: 1, expiresAt: 1, publishedAt: -1 },
  { name: "search_visibility_date" },
);

const SearchDocument = mongoose.model("SearchDocument", searchDocumentSchema);

module.exports = SearchDocument;
module.exports.SEARCH_SOURCE_TYPES = SEARCH_SOURCE_TYPES;
