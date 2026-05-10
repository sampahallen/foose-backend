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
    coverImage: String,
    type: {
      type: String,
      enum: ["pop-up", "fair", "online"],
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
