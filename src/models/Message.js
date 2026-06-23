const mongoose = require("mongoose");
const { Schema } = mongoose;

const messageSchema = new Schema(
  {
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiverId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    listingId: {
      type: Schema.Types.ObjectId,
      ref: "Listing",
    },
    content: {
      type: String,
      default: "",
    },
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: "Message",
    },
    reactions: [
      {
        userId: {
          type: Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        reaction: {
          type: String,
          enum: ["thumbs_up", "heart", "thumbs_down", "fire", "sad", "laugh"],
          required: true,
        },
      },
    ],
    attachments: [
      {
        url: {
          type: String,
          required: true,
        },
        type: {
          type: String,
          enum: ["image", "video"],
          required: true,
        },
        mimetype: String,
        originalname: String,
      },
    ],
    type: {
      type: String,
      enum: ["text", "image", "video", "mixed"],
      default: "text",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Message", messageSchema);
