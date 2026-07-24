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
    lifecycleEmailSentAt: {
      type: Date,
      select: false,
    },
    lifecycleEmailRequired: {
      type: Boolean,
      default: false,
      select: false,
    },
    lifecycleEmailAttemptCount: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },
    lifecycleEmailLastAttemptAt: {
      type: Date,
      select: false,
    },
    lifecycleEmailLastError: {
      type: String,
      maxlength: 500,
      default: "",
      select: false,
    },
    lifecycleEmailClaim: {
      token: { type: String, select: false },
      until: { type: Date, select: false },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, value) {
        delete value.eventKey;
        delete value.lifecycleEmailRequired;
        delete value.lifecycleEmailSentAt;
        delete value.lifecycleEmailAttemptCount;
        delete value.lifecycleEmailLastAttemptAt;
        delete value.lifecycleEmailLastError;
        delete value.lifecycleEmailClaim;
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
notificationSchema.index(
  { type: 1, lifecycleEmailSentAt: 1, "lifecycleEmailClaim.until": 1 },
  { name: "notification_lifecycle_email_pending" },
);

module.exports = mongoose.model("Notification", notificationSchema);
