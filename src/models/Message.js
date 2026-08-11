const mongoose = require("mongoose");
const { BARGAIN_ACTIONS, BARGAIN_ACTORS } = require("../constants/bargain");
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
        isRead: {
          type: Boolean,
          default: false,
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
      enum: ["text", "image", "video", "mixed", "offer"],
      default: "text",
    },
    bargainId: {
      type: Schema.Types.ObjectId,
      ref: "Bargain",
      index: true,
      sparse: true,
    },
    // Immutable snapshot of the round this message represents. The live
    // negotiation state lives on the Bargain; this is what keeps older cards in
    // the thread reading correctly after the bargain moves on.
    offer: {
      action: {
        type: String,
        enum: BARGAIN_ACTIONS,
      },
      actor: {
        type: String,
        enum: BARGAIN_ACTORS,
      },
      amount: Number,
      previousAmount: Number,
      round: Number,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Message", messageSchema);
