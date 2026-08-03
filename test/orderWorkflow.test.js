const test = require("node:test");
const assert = require("node:assert/strict");
const {
  presentOrder,
  workflowFor,
} = require("../src/services/orderWorkflowService");
const {
  DELIVERY_RELEASE_WINDOW_MS,
  PICKUP_WINDOW_MS,
  SELLER_ACTION_WINDOW_MS,
} = require("../src/constants/orderLifecycle");

const buyerId = "buyer-1";
const sellerId = "seller-1";
const now = new Date("2026-07-24T00:00:00.000Z");

const order = (overrides = {}) => ({
  _id: "order-1",
  activeReportId: null,
  buyerId,
  delivery: { method: "shop_pickup" },
  fulfillmentStatus: "awaiting_seller",
  settlementStatus: "cash_due",
  shopId: { ownerId: sellerId },
  ...overrides,
});

test("cash pickup exposes cancellation, readiness, completion, and the exact 72-hour release boundary", () => {
  const placed = order();
  assert.deepEqual(workflowFor(placed, buyerId, now).allowedActions, [
    "cancel_cash_pickup",
  ]);
  assert.deepEqual(workflowFor(placed, sellerId, now).allowedActions, [
    "mark_pickup_ready",
  ]);

  const readyAt = now;
  const pickupExpiresAt = new Date(now.getTime() + PICKUP_WINDOW_MS);
  const ready = order({
    fulfillmentStatus: "ready_for_pickup",
    pickupExpiresAt,
    readyAt,
  });
  assert.deepEqual(workflowFor(ready, sellerId, now).allowedActions, [
    "complete_cash_pickup",
  ]);
  assert.deepEqual(
    workflowFor(ready, sellerId, pickupExpiresAt).allowedActions,
    ["complete_cash_pickup", "release_unclaimed_pickup"],
  );
});

test("online pickup confirmation and reporting close exactly at 72 hours", () => {
  const pickupExpiresAt = new Date(now.getTime() + PICKUP_WINDOW_MS);
  const ready = order({
    fulfillmentStatus: "ready_for_pickup",
    pickupExpiresAt,
    settlementStatus: "held",
  });
  assert.deepEqual(workflowFor(ready, buyerId, now).allowedActions, [
    "confirm_collection",
    "report",
  ]);
  assert.deepEqual(
    workflowFor(ready, buyerId, pickupExpiresAt).allowedActions,
    [],
  );
});

test("delivery buyer actions close and system settlement becomes next at exactly 36 hours", () => {
  const deliveryReleaseAt = new Date(now.getTime() + DELIVERY_RELEASE_WINDOW_MS);
  const sent = order({
    delivery: { method: "station_pickup" },
    deliveryReleaseAt,
    fulfillmentStatus: "in_transit",
    settlementStatus: "held",
  });
  assert.deepEqual(workflowFor(sent, buyerId, now).allowedActions, [
    "confirm_receipt",
    "report",
  ]);
  const due = workflowFor(sent, buyerId, deliveryReleaseAt);
  assert.deepEqual(due.allowedActions, []);
  assert.equal(due.nextActor, "system");
});

test("seller can still dispatch after 72 hours until the buyer closes first", () => {
  const sellerActionDeadline = new Date(now.getTime() + SELLER_ACTION_WINDOW_MS);
  const awaiting = order({
    delivery: { method: "station_pickup" },
    sellerActionDeadline,
    settlementStatus: "held",
  });
  assert.deepEqual(
    workflowFor(awaiting, buyerId, sellerActionDeadline).allowedActions,
    ["close_no_action"],
  );
  assert.deepEqual(
    workflowFor(awaiting, sellerId, sellerActionDeadline).allowedActions,
    ["dispatch"],
  );
});

test("an active report freezes every participant action without changing fulfillment", () => {
  const reported = order({
    activeReportId: { _id: "report-1", status: "submitted" },
    fulfillmentStatus: "in_transit",
    settlementStatus: "held",
  });
  const workflow = workflowFor(reported, buyerId, now);
  assert.deepEqual(workflow.allowedActions, []);
  assert.equal(workflow.nextActor, "review");
  assert.equal(workflow.report.id, "report-1");
});

test("unpaid online orders wait on the buyer and serialize recipient compatibility aliases", () => {
  const pending = order({
    delivery: {
      destination: {
        recipientName: "Ama Buyer",
        recipientPhone: "+233200000000",
        region: "Ashanti",
        town: "Kumasi",
      },
      method: "station_pickup",
    },
    settlementStatus: "payment_pending",
  });
  const presented = presentOrder(pending, buyerId, now);
  assert.equal(presented.workflow.nextActor, "buyer");
  assert.deepEqual(presented.workflow.allowedActions, []);
  assert.deepEqual(presented.delivery.recipient, {
    name: "Ama Buyer",
    phone: "+233200000000",
  });
});

test("financially unresolved refunds do not appear as terminal history", () => {
  const refundPending = presentOrder(
    order({
      fulfillmentStatus: "cancelled",
      settlementStatus: "refund_pending",
    }),
    buyerId,
    now,
  );
  assert.equal(refundPending.workflow.bucket, "in_progress");
  assert.equal(refundPending.workflow.nextActor, "provider");

  const refundAttention = presentOrder(
    order({
      fulfillmentStatus: "cancelled",
      settlementStatus: "refund_attention",
    }),
    buyerId,
    now,
  );
  assert.equal(refundAttention.workflow.bucket, "under_review");
  assert.equal(refundAttention.workflow.nextActor, "operations");

  const refunded = presentOrder(
    order({
      fulfillmentStatus: "cancelled",
      settlementStatus: "refunded",
    }),
    buyerId,
    now,
  );
  assert.equal(refunded.workflow.bucket, "history");
});
