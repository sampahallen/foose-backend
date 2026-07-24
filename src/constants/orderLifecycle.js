const FULFILLMENT_STATUSES = Object.freeze([
  "awaiting_seller",
  "ready_for_pickup",
  "in_transit",
  "completed",
  "cancelled",
]);

const ORDER_SETTLEMENT_STATUSES = Object.freeze([
  "payment_pending",
  "cash_due",
  "cash_collected",
  "held",
  "released",
  "refund_pending",
  "refund_attention",
  "refunded",
  "refund_failed",
  "void",
]);

const PAYMENT_TRANSACTION_STATUSES = Object.freeze([
  "pending",
  "processing",
  "paid",
  "partially_refunded",
  "refunded",
  "cancelled",
  "failed",
]);

const SETTLEMENT_TYPES = Object.freeze(["release", "refund"]);

const SETTLEMENT_STATUSES = Object.freeze([
  "pending",
  "processing",
  "needs_attention",
  "processed",
  "failed",
]);

const SETTLEMENT_TRIGGERS = Object.freeze([
  "buyer_confirmation",
  "seller_cash_confirmation",
  "pickup_expiry",
  "delivery_expiry",
  "buyer_close",
  "report_resolution",
  "legacy_migration",
  "manual_recovery",
]);

const ORDER_REPORT_CATEGORIES = Object.freeze([
  "not_received",
  "invalid_transit_details",
  "seller_or_driver_unreachable",
  "wrong_or_missing_items",
  "damaged_or_not_as_described",
  "fraud_or_safety_concern",
  "other",
]);

const ORDER_REPORT_OUTCOMES = Object.freeze([
  "refund",
  "replacement",
  "complete_order",
  "other",
]);

const ORDER_REPORT_STATUSES = Object.freeze([
  "submitted",
  "under_review",
  "resolved",
  "dismissed",
]);

const ORDER_EVENT_ACTOR_TYPES = Object.freeze([
  "buyer",
  "seller",
  "admin",
  "system",
  "provider",
  "migration",
]);

const ORDER_ACTIONS = Object.freeze([
  "cancel_cash_pickup",
  "mark_pickup_ready",
  "complete_cash_pickup",
  "release_unclaimed_pickup",
  "confirm_collection",
  "dispatch",
  "confirm_receipt",
  "close_no_action",
  "report",
]);

const SELLER_ACTION_WINDOW_MS = 72 * 60 * 60 * 1000;
const PICKUP_WINDOW_MS = 72 * 60 * 60 * 1000;
const DELIVERY_RELEASE_WINDOW_MS = 36 * 60 * 60 * 1000;
const PAYMENT_RESERVATION_WINDOW_MS = 30 * 60 * 1000;
const LATE_CHARGE_WATCH_MS = 30 * 24 * 60 * 60 * 1000;

module.exports = {
  DELIVERY_RELEASE_WINDOW_MS,
  FULFILLMENT_STATUSES,
  LATE_CHARGE_WATCH_MS,
  ORDER_ACTIONS,
  ORDER_EVENT_ACTOR_TYPES,
  ORDER_REPORT_CATEGORIES,
  ORDER_REPORT_OUTCOMES,
  ORDER_REPORT_STATUSES,
  ORDER_SETTLEMENT_STATUSES,
  PAYMENT_RESERVATION_WINDOW_MS,
  PAYMENT_TRANSACTION_STATUSES,
  PICKUP_WINDOW_MS,
  SELLER_ACTION_WINDOW_MS,
  SETTLEMENT_STATUSES,
  SETTLEMENT_TRIGGERS,
  SETTLEMENT_TYPES,
};
