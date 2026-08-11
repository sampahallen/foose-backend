const mongoose = require("mongoose");
const { BARGAIN_CLOSE_REASONS, BARGAIN_STATUSES } = require("../constants/bargain");
const { Schema } = mongoose;

const bargainOfferSchema = new Schema(
  {
    actor: {
      type: String,
      enum: ["buyer", "seller"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 280,
      default: "",
    },
    messageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true },
);

const bargainSchema = new Schema(
  {
    listingId: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
      required: true,
      index: true,
    },
    buyerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sellerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    shopId: {
      type: Schema.Types.ObjectId,
      ref: "DigiShop",
      required: true,
    },
    // Denormalized `a_b_general` id so the thread can be opened without a lookup.
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    // Snapshot of the listing price when the bargain opened, in pesewas.
    // Kept so old cards still read "GHS 100 -> GHS 70" after the seller repriced.
    listPriceAtOpen: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "GHS",
    },
    status: {
      type: String,
      enum: BARGAIN_STATUSES,
      default: "awaiting_seller",
      index: true,
    },
    // Mirrors `status`: true while the bargain holds the buyer's slot on this
    // listing. Backs the partial unique index below, so every terminal
    // transition must clear it in the same update.
    isActive: {
      type: Boolean,
      default: true,
    },
    offers: {
      type: [bargainOfferSchema],
      default: [],
    },
    roundCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    agreedPrice: {
      type: Number,
      min: 0,
    },
    acceptedAt: Date,
    acceptedBy: {
      type: String,
      enum: ["buyer", "seller"],
    },
    consumedByOrderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
    },
    consumedAt: Date,
    closedReason: {
      type: String,
      enum: BARGAIN_CLOSE_REASONS,
    },
  },
  { timestamps: true },
);

// One live bargain per buyer per listing. Terminal transitions set
// `isActive: false`, which drops the document out of this index and frees the
// buyer to open a fresh negotiation.
bargainSchema.index(
  { listingId: 1, buyerId: 1 },
  {
    name: "bargain_active_per_buyer_listing",
    partialFilterExpression: { isActive: true },
    unique: true,
  },
);
bargainSchema.index({ conversationId: 1, updatedAt: -1 });
bargainSchema.index({ buyerId: 1, status: 1, updatedAt: -1 });
bargainSchema.index({ sellerId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model("Bargain", bargainSchema);
