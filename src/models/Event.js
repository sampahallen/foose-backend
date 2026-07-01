const mongoose = require("mongoose");
const { Schema } = mongoose;

const eventSchema = new Schema(
  {
    organizerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 60,
      default: "",
    },
    date: {
      type: Date,
      required: true,
    },
    location: {
      type: String,
      trim: true,
      default: "",
    },
    startTime: {
      type: String,
      trim: true,
      default: "",
    },
    endTime: {
      type: String,
      trim: true,
      default: "",
    },
    startsAt: {
      type: Date,
      index: true,
    },
    endsAt: {
      type: Date,
      index: true,
    },
    coverImage: String,
    shopId: {
      type: Schema.Types.ObjectId,
      ref: "DigiShop",
      index: true,
    },
    eventListings: [
      {
        type: Schema.Types.ObjectId,
        ref: "Listing",
      },
    ],
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
    type: {
      type: String,
      enum: ["online-pop-up", "in-person-pop-up", "pop-up", "fair", "online"],
      required: true,
    },
    attendees: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    status: {
      type: String,
      enum: ["upcoming", "ongoing", "past"],
      default: "upcoming",
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Event", eventSchema);
