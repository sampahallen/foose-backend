const mongoose = require("mongoose");
const {
  FULFILLMENT_STATUSES,
  ORDER_EVENT_ACTOR_TYPES,
  ORDER_SETTLEMENT_STATUSES,
} = require("../constants/orderLifecycle");

const { Schema } = mongoose;

const stateSnapshotSchema = new Schema(
  {
    fulfillmentStatus: {
      type: String,
      enum: FULFILLMENT_STATUSES,
    },
    settlementStatus: {
      type: String,
      enum: ORDER_SETTLEMENT_STATUSES,
    },
  },
  { _id: false },
);

const orderEventSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
      immutable: true,
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 100,
      match: /^[a-z0-9][a-z0-9_.-]*$/,
      immutable: true,
      index: true,
    },
    eventKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 240,
      immutable: true,
      select: false,
    },
    actorType: {
      type: String,
      enum: ORDER_EVENT_ACTOR_TYPES,
      required: true,
      immutable: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      immutable: true,
    },
    from: {
      type: stateSnapshotSchema,
      default: undefined,
      immutable: true,
    },
    to: {
      type: stateSnapshotSchema,
      default: undefined,
      immutable: true,
    },
    message: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
      immutable: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
      immutable: true,
      select: false,
    },
    notificationRequired: {
      type: Boolean,
      default: false,
      immutable: true,
      index: true,
    },
    notificationType: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 100,
      match: /^[a-z0-9][a-z0-9_.-]*$/,
      immutable: true,
    },
    notificationDispatchedAt: Date,
    notificationAttemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    notificationLastAttemptAt: Date,
    notificationNextAttemptAt: Date,
    notificationLastError: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    notificationClaim: {
      token: {
        type: String,
        select: false,
      },
      until: Date,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

orderEventSchema.index(
  { orderId: 1, eventKey: 1 },
  { name: "order_event_idempotency", unique: true },
);
orderEventSchema.index(
  { orderId: 1, createdAt: 1, _id: 1 },
  { name: "order_event_timeline" },
);
orderEventSchema.index(
  {
    notificationRequired: 1,
    notificationDispatchedAt: 1,
    notificationNextAttemptAt: 1,
    "notificationClaim.until": 1,
  },
  { name: "order_event_notification_outbox" },
);

module.exports = mongoose.model("OrderEvent", orderEventSchema);
