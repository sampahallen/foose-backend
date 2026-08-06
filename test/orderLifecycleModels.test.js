const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Order = require("../src/models/Order");
const OrderEvent = require("../src/models/OrderEvent");
const OrderReport = require("../src/models/OrderReport");
const PaymentTransaction = require("../src/models/PaymentTransaction");
const {
  inferFulfillmentStatus,
  inferSettlement,
  lifecycleUpdateForOrder,
  transactionStatusForOrders,
} = require("../scripts/migrateOrderLifecycle");
const {
  DELIVERY_RELEASE_WINDOW_MS,
  LATE_CHARGE_WATCH_MS,
  PAYMENT_RESERVATION_WINDOW_MS,
  PICKUP_WINDOW_MS,
  SELLER_ACTION_WINDOW_MS,
} = require("../src/constants/orderLifecycle");

const objectId = () => new mongoose.Types.ObjectId();

const orderInput = (overrides = {}) => ({
  buyerId: objectId(),
  delivery: { method: "shop_pickup" },
  escrowStatus: "not_held",
  items: [
    {
      listingId: objectId(),
      price: 1200,
      quantity: 1,
      title: "Test item",
    },
  ],
  paymentMethod: "cash_on_pickup",
  paymentStatus: "cash_on_pickup",
  shopId: objectId(),
  totalAmount: 1200,
  ...overrides,
});

test("Order derives explicit lifecycle defaults for legacy-compatible creation", () => {
  const cash = new Order(orderInput());
  assert.equal(cash.escrowStatus, "not_held");
  assert.equal(cash.fulfillmentStatus, "awaiting_seller");
  assert.equal(cash.settlementStatus, "cash_due");
  assert.equal(cash.validateSync(), undefined);

  const paid = new Order(
    orderInput({
      escrowStatus: "held",
      paymentMethod: "paystack",
      paymentStatus: "paid",
    }),
  );
  assert.equal(paid.fulfillmentStatus, "awaiting_seller");
  assert.equal(paid.settlementStatus, "held");
  assert.equal(paid.validateSync(), undefined);
});

test("Order exposes a per-shop checkout idempotency index", () => {
  const idempotencyIndex = Order.schema.indexes().find(
    ([keys]) =>
      keys.buyerId === 1 &&
      keys.checkoutIdempotencyKey === 1 &&
      keys.shopId === 1,
  );

  assert.ok(idempotencyIndex);
  assert.equal(idempotencyIndex[1].unique, true);
  assert.deepEqual(idempotencyIndex[1].partialFilterExpression, {
    checkoutIdempotencyKey: { $type: "string" },
  });

  const anchorIndex = Order.schema.indexes().find(
    ([keys, options]) =>
      keys.buyerId === 1 &&
      keys.checkoutIdempotencyKey === 1 &&
      options.name === "order_checkout_global_anchor",
  );
  assert.ok(anchorIndex);
  assert.equal(anchorIndex[1].unique, true);
  assert.equal(anchorIndex[1].partialFilterExpression.checkoutAnchor, true);
});

test("Order transit schema uses driver phone and optional parcel number only", () => {
  assert.ok(Order.schema.path("delivery.transit.driverPhone"));
  assert.ok(Order.schema.path("delivery.transit.parcelNumber"));
  assert.equal(Order.schema.path("delivery.transit.busNumber"), undefined);
  assert.equal(Order.schema.path("delivery.transit.lastStopLocation"), undefined);
});

test("OrderReport accepts migrated declarations but requires buyer declarations", () => {
  const base = {
    buyerId: objectId(),
    category: "other",
    declarationAccepted: false,
    detailedAccount: "This report includes enough detail for a safe migration.",
    orderId: objectId(),
    requestedOutcome: "other",
    shopId: objectId(),
  };
  const migrated = new OrderReport({
    ...base,
    source: {
      legacyOrderId: base.orderId,
      type: "legacy_migration",
    },
  });
  assert.equal(migrated.validateSync(), undefined);

  const systemHold = new OrderReport({
    ...base,
    source: { type: "system_payment_validation" },
  });
  assert.equal(systemHold.validateSync(), undefined);

  const buyerReport = new OrderReport(base);
  assert.match(
    buyerReport.validateSync().errors.declarationAccepted.message,
    /must be accepted/,
  );
});

test("OrderReport serialization never exposes private object storage keys", () => {
  const report = new OrderReport({
    affectedItemIds: [objectId()],
    buyerId: objectId(),
    category: "damaged_or_not_as_described",
    declarationAccepted: true,
    detailedAccount: "The item arrived damaged and the private photos document the issue.",
    evidence: [
      {
        key: "private/order-reports/secret-object-key.webp",
        mimetype: "image/webp",
        originalName: "damage.webp",
        size: 1024,
      },
    ],
    orderId: objectId(),
    requestedOutcome: "refund",
    shopId: objectId(),
  });

  const serialized = report.toJSON();
  assert.equal(serialized.evidence[0].key, undefined);
  assert.equal(serialized.evidence[0].originalName, "damage.webp");
});

test("PaymentTransaction enforces one or more grouped seller orders", () => {
  const transaction = new PaymentTransaction({
    amount: 1200,
    buyerId: objectId(),
    orderIds: [],
    providerReference: "migration-test-reference",
  });

  assert.match(
    transaction.validateSync().errors.orderIds.message,
    /at least one order/,
  );
});

test("PaymentTransaction rotates provider reconciliation attempts through a due index", () => {
  const index = PaymentTransaction.schema.indexes().find(
    ([keys, options]) =>
      keys.status === 1 &&
      keys.reconciliationNextAttemptAt === 1 &&
      options.name === "payment_transaction_reconciliation_due",
  );
  assert.ok(index);
  const payment = new PaymentTransaction({
    amount: 100,
    buyerId: objectId(),
    orderIds: [objectId()],
    providerReference: "payment-reconciliation-test",
  });
  assert.equal(payment.reconciliationAttemptCount, 0);
});

test("OrderEvent provides a durable, claimable notification outbox", () => {
  const index = OrderEvent.schema.indexes().find(
    ([, options]) => options.name === "order_event_notification_outbox",
  );
  assert.ok(index);
  assert.deepEqual(index[0], {
    notificationRequired: 1,
    notificationDispatchedAt: 1,
    notificationNextAttemptAt: 1,
    "notificationClaim.until": 1,
  });

  const event = new OrderEvent({
    actorType: "system",
    eventKey: "order-created:test",
    eventType: "order_created",
    notificationRequired: true,
    notificationType: "order_created",
    orderId: objectId(),
  });
  assert.equal(event.notificationAttemptCount, 0);
  assert.equal(event.notificationDispatchedAt, undefined);
  assert.equal(event.validateSync(), undefined);
});

test("legacy state mapping protects ambiguous paid orders", () => {
  const disputed = {
    escrowStatus: "held",
    paymentMethod: "paystack",
    paymentStatus: "paid",
    sellerAction: "shipped",
    status: "disputed",
  };
  const fulfillmentStatus = inferFulfillmentStatus(disputed);
  const settlement = inferSettlement(disputed, fulfillmentStatus);

  assert.equal(fulfillmentStatus, "in_transit");
  assert.equal(settlement.settlementStatus, "held");
  assert.equal(settlement.requiresManualReview, true);

  const completedWithoutRelease = inferSettlement(
    {
      escrowStatus: "held",
      paymentMethod: "paystack",
      paymentStatus: "paid",
      status: "delivered",
    },
    "completed",
  );
  assert.equal(completedWithoutRelease.settlementStatus, "held");
  assert.equal(completedWithoutRelease.requiresManualReview, true);

  const mismatchedEscrow = inferSettlement(
    {
      escrowStatus: "held",
      paymentMethod: "paystack",
      paymentStatus: "unpaid",
      status: "pending",
    },
    "awaiting_seller",
  );
  assert.equal(mismatchedEscrow.settlementStatus, "held");
  assert.equal(mismatchedEscrow.requiresManualReview, true);
});

test("legacy migration replaces old deadlines with exact lifecycle windows", () => {
  const paidAt = new Date("2026-01-01T00:00:00.000Z");
  const sentAt = new Date("2026-01-02T00:00:00.000Z");
  const order = {
    _id: objectId(),
    createdAt: new Date("2025-12-31T00:00:00.000Z"),
    delivery: { method: "delivery" },
    escrowStatus: "held",
    paidAt,
    paymentMethod: "paystack",
    paymentStatus: "paid",
    sellerAction: "shipped",
    sellerActionAt: sentAt,
    status: "shipped",
    updatedAt: sentAt,
  };
  const fulfillmentStatus = inferFulfillmentStatus(order);
  const settlement = inferSettlement(order, fulfillmentStatus);
  const update = lifecycleUpdateForOrder({
    fulfillmentStatus,
    order,
    settlement,
  });

  assert.equal(fulfillmentStatus, "in_transit");
  assert.equal(
    update.deliveryReleaseAt.getTime() - sentAt.getTime(),
    DELIVERY_RELEASE_WINDOW_MS,
  );
});

test("lifecycle timing constants are exact rolling hours", () => {
  assert.equal(SELLER_ACTION_WINDOW_MS, 72 * 60 * 60 * 1000);
  assert.equal(PICKUP_WINDOW_MS, 72 * 60 * 60 * 1000);
  assert.equal(DELIVERY_RELEASE_WINDOW_MS, 36 * 60 * 60 * 1000);
  assert.equal(PAYMENT_RESERVATION_WINDOW_MS, 30 * 60 * 1000);
  assert.equal(LATE_CHARGE_WATCH_MS, 30 * 24 * 60 * 60 * 1000);
});

test("legacy payment transaction status reflects partial refunds", () => {
  assert.equal(
    transactionStatusForOrders([
      { paymentStatus: "paid", status: "paid" },
      { paymentStatus: "refunded", status: "refunded" },
    ]),
    "partially_refunded",
  );
});
