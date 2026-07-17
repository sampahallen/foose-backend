const mongoose = require("mongoose");
const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["order", "chat", "review", "kyc", "system"],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      trim: true,
      default: "",
    },
    link: {
      type: String,
      trim: true,
      default: "",
    },
    eventKey: {
      type: String,
      trim: true,
      maxlength: 240,
      select: false,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, value) {
        delete value.eventKey;
        return value;
      },
    },
  },
);

notificationSchema.index(
  { userId: 1, eventKey: 1 },
  {
    name: "notification_user_event_unique",
    partialFilterExpression: { eventKey: { $type: "string" } },
    unique: true,
  },
);
notificationSchema.index(
  { userId: 1, isRead: 1, createdAt: -1 },
  { name: "notification_user_read_created" },
);

module.exports = mongoose.model("Notification", notificationSchema);
