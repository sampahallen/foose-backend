const crypto = require("crypto");
const mongoose = require("mongoose");
const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const Notification = require("../models/Notification");
const Order = require("../models/Order");
const OrderEvent = require("../models/OrderEvent");
const OrderReport = require("../models/OrderReport");
const PaymentTransaction = require("../models/PaymentTransaction");
const Settlement = require("../models/Settlement");
const User = require("../models/User");
const WalletLedgerEntry = require("../models/WalletLedgerEntry");
const {
  DELIVERY_RELEASE_WINDOW_MS,
  LATE_CHARGE_WATCH_MS,
  PAYMENT_RESERVATION_WINDOW_MS,
  PICKUP_WINDOW_MS,
  SELLER_ACTION_WINDOW_MS,
} = require("../constants/orderLifecycle");
const { USER_ROLES } = require("../constants/roles");
const { deletePrivateObject } = require("../config/s3");
const httpError = require("../utils/httpError");
const { invalidate } = require("../utils/cache");
const { createNotification } = require("./notificationService");
const { sendOrderLifecycleEmail } = require("./emailService");
const {
  createRefund,
  fetchRefund,
  listRefunds,
  verifyTransaction,
} = require("./paystackService");
const { awardPurchaseForOrder } = require("./recommendationService");
const {
  runSearchSync,
  syncListingSearchDocument,
} = require("./searchIndexService");

const participantPopulate = [
  {
    path: "shopId",
    select: "ownerId shopName slug location",
    populate: {
      path: "ownerId",
      select: "name username email phone",
    },
  },
  { path: "buyerId", select: "name username email phone isKycVerified" },
  { path: "items.listingId", select: "title images price currency type" },
  {
    path: "activeReportId",
    select:
      "status submittedAt frozenAt category affectedItemIds requestedOutcome detailedAccount evidence declarationAccepted",
  },
];

const sessionOptions = (session, options = {}) =>
  session ? { ...options, session } : options;

const createDocument = async (Model, document, session) => {
  const [created] = await Model.create(
    [document],
    sessionOptions(session),
  );
  return created;
};

const providerPaidAt = (transaction, fallback = new Date()) => {
  const value =
    transaction?.paid_at ||
    transaction?.paidAt ||
    transaction?.paid_at_iso ||
    null;
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const withTransaction = async (work) => {
  if (
    mongoose.connection.readyState !== 1 &&
    (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT)
  ) {
    return work(null);
  }
  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      },
    );
    return result;
  } finally {
    await session.endSession();
  }
};

const normalizedIdempotencyKey = ({ action, key, orderId, userId }) => {
  const supplied = String(key || "").trim();
  const safe = supplied.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 120);
  return `${action}:${orderId}:${safe || `actor-${userId}`}`.slice(0, 230);
};

const stateSnapshot = (order) => ({
  fulfillmentStatus: order.fulfillmentStatus,
  settlementStatus: order.settlementStatus,
});

const appendOrderEvent = async ({
  actorId,
  actorType,
  eventKey,
  eventType,
  from,
  message,
  metadata,
  notificationType,
  order,
  session,
}) => {
  const resolvedNotificationType =
    notificationType || (eventMessages[eventType] ? eventType : "");
  return createDocument(
    OrderEvent,
    {
      actorId,
      actorType,
      eventKey,
      eventType,
      from,
      message,
      metadata,
      notificationRequired: Boolean(resolvedNotificationType),
      notificationType: resolvedNotificationType || undefined,
      orderId: order._id,
      to: stateSnapshot(order),
    },
    session,
  );
};

const loadParticipantOrder = async (orderId, userId) => {
  const order = await Order.findById(orderId).populate(participantPopulate);
  if (!order) throw httpError(404, "Order not found");

  const buyerId = String(order.buyerId?._id || order.buyerId);
  const sellerId = String(order.shopId?.ownerId?._id || order.shopId?.ownerId || "");
  const isBuyer = buyerId === String(userId);
  const isSeller = sellerId === String(userId);

  if (!isBuyer && !isSeller) {
    throw httpError(403, "You do not have access to this order");
  }

  return { isBuyer, isSeller, order };
};

const assertRole = (participant, role) => {
  if (role === "buyer" && !participant.isBuyer) {
    throw httpError(403, "Only the buyer can perform this action");
  }
  if (role === "seller" && !participant.isSeller) {
    throw httpError(403, "Only the shop owner can perform this action");
  }
};

const actorTypeFor = (participant) => (participant.isSeller ? "seller" : "buyer");

const refreshParticipantOrder = (orderId) =>
  Order.findById(orderId).populate(participantPopulate);

const eventMessages = {
  order_created: {
    buyer: ["Order sent to seller", "The seller received your cash pickup order."],
    seller: [
      "New pickup order",
      "A buyer placed a cash pickup. Mark it ready when it can be collected.",
    ],
  },
  cash_pickup_cancelled: {
    seller: ["Pickup order cancelled", "The buyer cancelled this pickup before it was ready."],
  },
  cash_pickup_completed: {
    buyer: ["Pickup completed", "The seller confirmed that the item was collected and cash was received."],
  },
  delivery_dispatched: {
    buyer: ["Your parcel is on the way", "The seller submitted the transit details for your order."],
  },
  delivery_received: {
    seller: ["Delivery confirmed", "The buyer confirmed receipt and the protected funds were released."],
  },
  funds_released: {
    buyer: ["Order completed", "The protected order total was released to the seller."],
    seller: ["Funds released", "The order total is now available in your Foose wallet."],
  },
  order_reported: {
    buyer: ["Report submitted", "Funds are frozen while the order report awaits review."],
    seller: ["Order reported", "The protected funds are frozen while the buyer's report awaits review."],
  },
  pickup_ready: {
    buyer: ["Pickup is ready", "Your order is ready to collect. Check the order before confirming collection."],
  },
  pickup_released: {
    buyer: ["Pickup returned to inventory", "The unclaimed cash pickup was cancelled after its pickup window."],
  },
  payment_reservation_expired: {
    buyer: [
      "Payment session expired",
      "The unpaid checkout expired and its reserved items returned to inventory.",
    ],
  },
  payment_confirmed: {
    buyer: [
      "Payment confirmed",
      "Payment is protected. The seller has 72 hours to prepare the order.",
    ],
    seller: [
      "New paid order",
      "A buyer paid for an order. The full total is held until completion.",
    ],
  },
  payment_validation_attention: {
    buyer: [
      "Payment needs review",
      "The charge was received with inconsistent checkout details. Inventory remains reserved while operations reviews it.",
    ],
    operations: [
      "Charged checkout needs review",
      "A successful Paystack charge failed checkout validation and requires manual financial review.",
    ],
  },
  refund_failed: {
    buyer: ["Refund needs attention", "Your refund did not complete and operations follow-up is required."],
    operations: [
      "Order refund needs attention",
      "A Paystack refund is financially unresolved and requires operations review.",
    ],
  },
  refund_pending: {
    buyer: ["Refund started", "A full refund to your original payment method is being processed."],
    seller: ["Order refunded", "The order was cancelled and its item inventory was restored."],
  },
  refund_processed: {
    buyer: ["Refund completed", "The full order total was returned to the original payment method."],
  },
};

const deliverLifecycleNotificationEmail = async ({
  notification,
  order,
  user,
}) => {
  if (!notification?._id || !order || !user) return false;
  const now = new Date();
  const token = crypto.randomUUID();
  const claim = await Notification.findOneAndUpdate(
    {
      _id: notification._id,
      lifecycleEmailRequired: true,
      lifecycleEmailSentAt: null,
      $or: [
        { "lifecycleEmailClaim.until": { $exists: false } },
        { "lifecycleEmailClaim.until": null },
        { "lifecycleEmailClaim.until": { $lte: now } },
      ],
    },
    {
      $inc: { lifecycleEmailAttemptCount: 1 },
      $set: {
        lifecycleEmailLastAttemptAt: now,
        "lifecycleEmailClaim.token": token,
        "lifecycleEmailClaim.until": new Date(now.getTime() + 2 * 60 * 1000),
      },
    },
    { new: true },
  ).select("+lifecycleEmailClaim.token");
  if (!claim) return false;

  try {
    await sendOrderLifecycleEmail({
      message: notification.body,
      order,
      subject: notification.title,
      user,
    });
    await Notification.updateOne(
      { _id: notification._id, "lifecycleEmailClaim.token": token },
      {
        $set: {
          lifecycleEmailLastError: "",
          lifecycleEmailSentAt: new Date(),
        },
        $unset: { lifecycleEmailClaim: 1 },
      },
    );
    return true;
  } catch (error) {
    await Notification.updateOne(
      { _id: notification._id, "lifecycleEmailClaim.token": token },
      {
        $set: {
          lifecycleEmailLastError: String(
            error.message || "Lifecycle email delivery failed",
          ).slice(0, 500),
          "lifecycleEmailClaim.until": new Date(Date.now() + 60 * 1000),
        },
        $unset: { "lifecycleEmailClaim.token": 1 },
      },
    ).catch(() => undefined);
    return false;
  }
};

const notifyLifecycleEvent = async (orderInput, eventType) => {
  const order = await Order.findById(orderInput._id || orderInput)
    .populate("shopId", "ownerId shopName")
    .populate("buyerId", "name username email");
  if (!order) return;

  const messages = eventMessages[eventType] || {};
  const financialSellerEvents = new Set([
    "funds_released",
    "refund_failed",
    "refund_pending",
    "refund_processed",
  ]);
  const sellerRecipientId =
    financialSellerEvents.has(eventType) && order.settlementSellerId
      ? order.settlementSellerId
      : order.shopId?.ownerId;
  const operations = messages.operations
    ? await User.find({
        $or: [
          { "roles.disputeResolver": USER_ROLES.DISPUTE_RESOLVER },
          { "roles.superAdmin": USER_ROLES.SUPER_ADMIN },
        ],
      }).select("name username email")
    : [];
  const targets = {
    buyer: [order.buyerId],
    operations,
    seller: [
      await User.findById(sellerRecipientId).select("name username email"),
    ],
  };

  const deliveries = await Promise.allSettled(
    Object.entries(messages).flatMap(([targetType, [title, body]]) => {
      const users = (targets[targetType] || []).filter((user) => user?._id);
      return users.map(async (user) => {
        const eventKey = `order:${order._id}:${eventType}:${targetType}:${user._id}`;
        const notification = await createNotification({
          body,
          eventKey,
          link: `/orders/${order._id}`,
          lifecycleEmailRequired: true,
          title,
          type: "order",
          userId: user._id,
        });
        await deliverLifecycleNotificationEmail({
          notification,
          order,
          user,
        });
      });
    }),
  );
  const failed = deliveries.filter((delivery) => delivery.status === "rejected");
  if (failed.length) {
    throw new AggregateError(
      failed.map((delivery) => delivery.reason),
      `Order notification delivery failed for ${eventType}`,
    );
  }
  await OrderEvent.updateMany(
    {
      notificationDispatchedAt: null,
      notificationRequired: true,
      notificationType: eventType,
      orderId: order._id,
    },
    {
      $set: {
        notificationDispatchedAt: new Date(),
        notificationLastError: "",
      },
      $unset: {
        notificationClaim: 1,
        notificationNextAttemptAt: 1,
      },
    },
  );
  return deliveries;
};

const syncRestoredInventory = async (order) => {
  const ids = [
    ...new Set(
      (order.items || [])
        .map((item) => String(item.listingId?._id || item.listingId || ""))
        .filter(Boolean),
    ),
  ];

  await Promise.allSettled(
    ids.map((listingId) =>
      runSearchSync(`listing:${listingId}:inventory-restored`, () =>
        syncListingSearchDocument(listingId)),
    ),
  );
  await invalidate(
    "listings:featured",
    `shop:${order.shopId?._id || order.shopId}:listings`,
    ...ids.map((listingId) => `listing:${listingId}`),
  ).catch(() => undefined);
};

const restoreInventory = async (order, session) => {
  for (const item of order.items || []) {
    if (!item.listingId) {
      throw httpError(
        409,
        `Inventory restoration for order ${order._id} requires operations attention`,
      );
    }
    const quantity = Math.max(Number(item.quantity || 1), 1);
    const result = await Listing.updateOne(
      { _id: item.listingId },
      [
        {
          $set: {
            quantity: {
              $add: [{ $ifNull: ["$quantity", 0] }, quantity],
            },
            status: {
              $cond: [{ $eq: ["$status", "sold"] }, "active", "$status"],
            },
          },
        },
      ],
      sessionOptions(session),
    );
    if (Number(result.matchedCount ?? result.modifiedCount ?? 0) !== 1) {
      throw httpError(
        409,
        `Inventory restoration for order ${order._id} could not find listing ${item.listingId}`,
      );
    }
  }
};

const assertSellerOwnershipInTransaction = async ({
  orderId,
  session,
  userId,
}) => {
  const orderQuery = Order.findById(orderId).select("shopId");
  const order = session ? await orderQuery.session(session) : await orderQuery;
  let shop = null;
  if (order) {
    const shopQuery = DigiShop.findOne({
      _id: order.shopId,
      ownerId: userId,
    }).select("_id");
    shop = session ? await shopQuery.session(session) : await shopQuery;
  }
  if (!shop) {
    throw httpError(403, "Only the current shop owner can perform this action");
  }
};

const actionAlreadyApplied = async (orderId, eventKey, session) => {
  const query = OrderEvent.findOne({ eventKey, orderId });
  if (session) query.session(session);
  return query;
};

const simpleTransition = async ({
  action,
  actorId,
  eventMessage,
  eventType,
  filter,
  idempotencyKey,
  role,
  update,
}) => {
  const participant = await loadParticipantOrder(filter._id, actorId);
  assertRole(participant, role);
  const eventKey = normalizedIdempotencyKey({
    action,
    key: idempotencyKey,
    orderId: filter._id,
    userId: actorId,
  });

  const transition = await withTransaction(async (session) => {
    if (role === "seller") {
      await assertSellerOwnershipInTransaction({
        orderId: filter._id,
        session,
        userId: actorId,
      });
    }
    if (await actionAlreadyApplied(filter._id, eventKey, session)) {
      return {
        order: await Order.findById(filter._id).session(session),
        wasApplied: false,
      };
    }

    const current = await Order.findOne(filter).session(session);
    if (!current) {
      throw httpError(409, "This order changed and the action is no longer available");
    }
    const from = stateSnapshot(current);
    const nextUpdate = typeof update === "function" ? update(current) : update;
    const updated = await Order.findOneAndUpdate(
      { ...filter, _id: current._id },
      nextUpdate,
      sessionOptions(session, { new: true, runValidators: true }),
    );
    if (!updated) {
      throw httpError(409, "This order changed and the action is no longer available");
    }

    await appendOrderEvent({
      actorId,
      actorType: role,
      eventKey,
      eventType,
      from,
      message: eventMessage,
      order: updated,
      session,
    });
    return { order: updated, wasApplied: true };
  });

  try {
    await notifyLifecycleEvent(transition.order, eventType);
    return await refreshParticipantOrder(transition.order._id);
  } catch (error) {
    error.transitionApplied = transition.wasApplied;
    error.transitionCommitted = true;
    throw error;
  }
};

const cancelCashPickup = async ({
  idempotencyKey,
  now = new Date(),
  orderId,
  userId,
}) => {
  const participant = await loadParticipantOrder(orderId, userId);
  assertRole(participant, "buyer");
  const eventKey = normalizedIdempotencyKey({
    action: "cancel_cash_pickup",
    key: idempotencyKey,
    orderId,
    userId,
  });

  const order = await withTransaction(async (session) => {
    if (await actionAlreadyApplied(orderId, eventKey, session)) {
      return Order.findById(orderId).session(session);
    }
    const current = await Order.findOne({
      _id: orderId,
      buyerId: userId,
      "delivery.method": "shop_pickup",
      fulfillmentStatus: "awaiting_seller",
      settlementStatus: "cash_due",
    }).session(session);
    if (!current) {
      throw httpError(409, "This cash pickup can no longer be cancelled");
    }
    const from = stateSnapshot(current);
    const updated = await Order.findOneAndUpdate(
      {
        _id: current._id,
        fulfillmentStatus: "awaiting_seller",
        settlementStatus: "cash_due",
      },
      {
        $set: {
          cancelledAt: now,
          fulfillmentStatus: "cancelled",
          inventoryRestoredAt: now,
          settlementExplanation: "The buyer cancelled before pickup was ready.",
          settlementStatus: "void",
          status: "cancelled",
        },
        $unset: { workflowDeadlineAt: 1 },
      },
      sessionOptions(session, { new: true }),
    );
    if (!updated) throw httpError(409, "This cash pickup already changed");
    await restoreInventory(updated, session);
    await appendOrderEvent({
      actorId: userId,
      actorType: "buyer",
      eventKey,
      eventType: "cash_pickup_cancelled",
      from,
      message: "Buyer cancelled the cash pickup before it was marked ready.",
      order: updated,
      session,
    });
    return updated;
  });

  await Promise.all([
    notifyLifecycleEvent(order, "cash_pickup_cancelled"),
    syncRestoredInventory(order),
  ]);
  return refreshParticipantOrder(order._id);
};

const markPickupReady = ({
  idempotencyKey,
  note,
  now = new Date(),
  orderId,
  userId,
}) =>
  simpleTransition({
    action: "mark_pickup_ready",
    actorId: userId,
    eventMessage: "Seller marked the order ready for pickup.",
    eventType: "pickup_ready",
    filter: {
      _id: orderId,
      "delivery.method": "shop_pickup",
      fulfillmentStatus: "awaiting_seller",
      settlementStatus: { $in: ["cash_due", "held"] },
    },
    idempotencyKey,
    role: "seller",
    update: {
      $set: {
        autoReleaseAt: new Date(now.getTime() + PICKUP_WINDOW_MS),
        fulfillmentStatus: "ready_for_pickup",
        pickupExpiresAt: new Date(now.getTime() + PICKUP_WINDOW_MS),
        readyAt: now,
        sellerAction: "pickup_ready",
        sellerActionAt: now,
        sellerNote: String(note || "").trim().slice(0, 1000),
        status: "processing",
        workflowDeadlineAt: new Date(now.getTime() + PICKUP_WINDOW_MS),
      },
    },
  });

const completeCashPickup = ({
  idempotencyKey,
  now = new Date(),
  orderId,
  userId,
}) =>
  simpleTransition({
    action: "complete_cash_pickup",
    actorId: userId,
    eventMessage: "Seller confirmed item collection and cash receipt.",
    eventType: "cash_pickup_completed",
    filter: {
      _id: orderId,
      "delivery.method": "shop_pickup",
      fulfillmentStatus: "ready_for_pickup",
      settlementStatus: "cash_due",
    },
    idempotencyKey,
    role: "seller",
    update: {
      $set: {
        completedAt: now,
        fulfillmentStatus: "completed",
        paymentStatus: "cash_on_pickup",
        settledAt: now,
        settlementExplanation: "The seller confirmed collection and cash receipt.",
        settlementStatus: "cash_collected",
        status: "delivered",
      },
      $unset: { autoReleaseAt: 1, workflowDeadlineAt: 1 },
    },
  });

const releaseUnclaimedPickup = async ({
  idempotencyKey,
  now = new Date(),
  orderId,
  userId,
}) => {
  const participant = await loadParticipantOrder(orderId, userId);
  assertRole(participant, "seller");
  const eventKey = normalizedIdempotencyKey({
    action: "release_unclaimed_pickup",
    key: idempotencyKey,
    orderId,
    userId,
  });

  const order = await withTransaction(async (session) => {
    await assertSellerOwnershipInTransaction({
      orderId,
      session,
      userId,
    });
    if (await actionAlreadyApplied(orderId, eventKey, session)) {
      return Order.findById(orderId).session(session);
    }
    const current = await Order.findOne({
      _id: orderId,
      "delivery.method": "shop_pickup",
      fulfillmentStatus: "ready_for_pickup",
      pickupExpiresAt: { $lte: now },
      settlementStatus: "cash_due",
    }).session(session);
    if (!current) {
      throw httpError(409, "The pickup window has not expired or this order already changed");
    }
    const from = stateSnapshot(current);
    const updated = await Order.findOneAndUpdate(
      {
        _id: current._id,
        fulfillmentStatus: "ready_for_pickup",
        settlementStatus: "cash_due",
      },
      {
        $set: {
          cancelledAt: now,
          fulfillmentStatus: "cancelled",
          inventoryRestoredAt: now,
          settlementExplanation: "The seller returned the unclaimed cash pickup to inventory.",
          settlementStatus: "void",
          status: "cancelled",
        },
        $unset: { autoReleaseAt: 1, workflowDeadlineAt: 1 },
      },
      sessionOptions(session, { new: true }),
    );
    if (!updated) throw httpError(409, "This order already changed");
    await restoreInventory(updated, session);
    await appendOrderEvent({
      actorId: userId,
      actorType: "seller",
      eventKey,
      eventType: "pickup_released",
      from,
      message: "Seller returned the unclaimed cash pickup to inventory.",
      order: updated,
      session,
    });
    return updated;
  });

  await Promise.all([
    notifyLifecycleEvent(order, "pickup_released"),
    syncRestoredInventory(order),
  ]);
  return refreshParticipantOrder(order._id);
};

const settlementProviderStatus = (status) => {
  const normalized = String(status || "pending").toLowerCase().replace(/-/g, "_");
  if (normalized === "processed" || normalized === "success") return "processed";
  if (normalized === "needs_attention") return "needs_attention";
  if (normalized === "failed") return "failed";
  if (normalized === "processing") return "processing";
  return "pending";
};

const orderRefundStatus = (status) => {
  if (status === "processed") return "refunded";
  if (status === "needs_attention") return "refund_attention";
  if (status === "failed") return "refund_failed";
  return "refund_pending";
};

const applyRefundProviderUpdate = async ({
  providerReference,
  providerStatus,
  settlementId,
}) => {
  const mapped = settlementProviderStatus(providerStatus);
  const allowedCurrentStatuses = {
    failed: ["pending", "processing", "failed"],
    needs_attention: ["pending", "processing", "needs_attention", "failed"],
    pending: ["pending"],
    processed: ["pending", "processing", "needs_attention", "failed"],
    processing: ["pending", "processing"],
  };
  const result = await withTransaction(async (session) => {
    const settlement = await Settlement.findById(settlementId).session(session);
    if (!settlement) return null;
    const replayingSameStatus = settlement.status === mapped;
    const replayingProcessed =
      replayingSameStatus && mapped === "processed";
    if (
      !replayingProcessed &&
      !allowedCurrentStatuses[mapped].includes(settlement.status)
    ) {
      return {
        order: await Order.findById(settlement.orderId).session(session),
        settlement,
        changed: false,
      };
    }

    const now = new Date();
    if (!replayingProcessed) {
      settlement.status = mapped;
      settlement.providerReference = String(providerReference || "");
      settlement.providerStatus = String(providerStatus || "");
      if (mapped === "failed") settlement.failedAt = now;
      if (mapped === "processed") settlement.processedAt = now;
    }
    const settlementStatus = orderRefundStatus(mapped);
    const order = await Order.findByIdAndUpdate(
      settlement.orderId,
      {
        $set: {
          ...(mapped === "processed"
            ? {
                escrowStatus: "refunded",
                paymentStatus: "refunded",
                settledAt: settlement.processedAt || now,
                status: "refunded",
              }
            : {}),
          settlementExplanation:
            mapped === "processed"
              ? "The full order total was refunded to the original payment method."
              : mapped === "needs_attention"
                ? "The payment provider needs attention before this refund can complete."
                : mapped === "failed"
                  ? "The refund failed and requires operations follow-up."
                  : "A refund to the original payment method is being processed.",
          settlementStatus,
        },
      },
      sessionOptions(session, { new: true }),
    );

    if (
      mapped === "processed" &&
      settlement.paymentTransactionId &&
      !settlement.accountingAppliedAt
    ) {
      await PaymentTransaction.updateOne(
        { _id: settlement.paymentTransactionId },
        [
          {
            $set: {
              refundedAmount: {
                $min: [
                  "$amount",
                  {
                    $add: [
                      { $ifNull: ["$refundedAmount", 0] },
                      Number(settlement.amount),
                    ],
                  },
                ],
              },
            },
          },
          {
            $set: {
              status: {
                $cond: [
                  { $gte: ["$refundedAmount", "$amount"] },
                  "refunded",
                  "partially_refunded",
                ],
              },
            },
          },
        ],
        sessionOptions(session),
      );
      settlement.accountingAppliedAt = now;
    }
    await settlement.save(sessionOptions(session));

    if (["processed", "failed", "needs_attention"].includes(mapped)) {
      const eventKey = `refund:${settlement._id}:${mapped}`;
      const existingEvent = await OrderEvent.findOne({
        eventKey,
        orderId: order._id,
      }).session(session);
      if (!existingEvent) {
        await appendOrderEvent({
          actorType: "provider",
          eventKey,
          eventType:
            mapped === "processed"
              ? "refund_processed"
              : mapped === "failed"
                ? "refund_failed"
                : "refund_attention",
          message:
            mapped === "processed"
              ? "Paystack confirmed the refund."
              : `Paystack reported refund status ${providerStatus}.`,
          notificationType:
            mapped === "needs_attention" ? "refund_failed" : undefined,
          order,
          session,
        });
      }
    }
    return {
      changed: true,
      notificationNeeded: !replayingSameStatus,
      order,
      settlement,
    };
  });

  if (!result) return null;
  if (mapped === "processed") {
    await notifyLifecycleEvent(result.order, "refund_processed");
  } else if (
    (mapped === "failed" || mapped === "needs_attention")
  ) {
    await notifyLifecycleEvent(result.order, "refund_failed");
  }
  return { order: result.order, settlement: result.settlement };
};

const reconcileRefundWithoutProviderId = async (settlement, order) => {
  let payment = settlement.paymentTransactionId
    ? await PaymentTransaction.findById(settlement.paymentTransactionId).select(
        "+providerMetadata",
      )
    : null;
  let providerTransactionId = payment?.providerMetadata?.id;

  if (!providerTransactionId && order.paymentRef) {
    const verified = await verifyTransaction(order.paymentRef);
    providerTransactionId = verified?.id;
    if (payment && providerTransactionId) {
      payment.providerMetadata = {
        ...(payment.providerMetadata || {}),
        id: providerTransactionId,
      };
      await payment.save();
    }
  }
  if (!providerTransactionId) return null;

  const refunds = await listRefunds({
    currency: order.currency,
    perPage: 50,
    transaction: providerTransactionId,
  });
  const expectedNote = `Full refund for Foose order ${order._id}`;
  return (refunds || []).find(
    (refund) =>
      Number(refund.amount) === Number(order.totalAmount) &&
      String(refund.currency || "").toUpperCase() ===
        String(order.currency || "GHS").toUpperCase() &&
      String(refund.merchant_note || "").includes(expectedNote),
  );
};

const processRefundSettlement = async (settlementId) => {
  let settlement = await Settlement.findById(settlementId).select(
    "+idempotencyKey +metadata",
  );
  if (!settlement || settlement.type !== "refund") return null;
  if (settlement.status === "processed") {
    return { order: await Order.findById(settlement.orderId), settlement };
  }
  const order = await Order.findById(settlement.orderId);
  if (!order) return null;

  if (settlement.providerReference) {
    try {
      const refund = await fetchRefund(settlement.providerReference);
      return applyRefundProviderUpdate({
        providerReference: refund.id || settlement.providerReference,
        providerStatus: refund.status,
        settlementId: settlement._id,
      });
    } catch (error) {
      await Settlement.findByIdAndUpdate(settlement._id, {
        $set: {
          lastError: {
            at: new Date(),
            code: String(error.code || ""),
            message: String(error.message || "Refund reconciliation failed").slice(0, 1000),
          },
        },
      });
      return { order, settlement };
    }
  }

  if (Number(settlement.attemptCount || 0) > 0) {
    try {
      const refund = await reconcileRefundWithoutProviderId(settlement, order);
      if (refund) {
        return applyRefundProviderUpdate({
          providerReference: refund.id,
          providerStatus: refund.status,
          settlementId: settlement._id,
        });
      }
    } catch (error) {
      await Settlement.findByIdAndUpdate(settlement._id, {
        $set: {
          lastError: {
            at: new Date(),
            code: String(error.code || ""),
            message: String(error.message || "Refund reconciliation failed").slice(0, 1000),
          },
        },
      });
      return { order, settlement };
    }

    /*
     * A POST may have reached Paystack even if this process never received the
     * response. Never issue another refund blindly. Escalate the unresolved
     * attempt for operations rather than risking a duplicate refund.
     */
    await Settlement.findByIdAndUpdate(
      settlement._id,
      {
        $set: {
          lastError: {
            at: new Date(),
            code: "REFUND_RECONCILIATION_REQUIRED",
            message:
              "A previous refund attempt has no provider id and could not be reconciled safely.",
          },
        },
        $unset: { processingClaim: 1 },
      },
    );
    const reconciled = await applyRefundProviderUpdate({
      providerReference: "",
      providerStatus: "needs-attention",
      settlementId: settlement._id,
    });
    return reconciled;
  }

  const claimToken = crypto.randomUUID();
  settlement = await Settlement.findOneAndUpdate(
    {
      _id: settlement._id,
      attemptCount: 0,
      status: { $in: ["pending", "processing", "failed"] },
    },
    {
      $inc: { attemptCount: 1 },
      $set: {
        "metadata.lastAttemptAt": new Date(),
        processingClaim: {
          token: claimToken,
          until: new Date(Date.now() + 2 * 60 * 1000),
        },
        status: "processing",
      },
    },
    { new: true },
  ).select("+idempotencyKey +metadata");
  if (!settlement) {
    return {
      order,
      settlement: await Settlement.findById(settlementId),
    };
  }

  try {
    const refund = await createRefund({
      amount: order.totalAmount,
      currency: order.currency,
      customerNote: "Foose order refund",
      merchantNote: `Full refund for Foose order ${order._id}`,
      transaction: order.paymentRef,
    });
    await Settlement.findByIdAndUpdate(settlement._id, {
      $set: { providerReference: String(refund.id || refund.refund_reference || "") },
      $unset: { processingClaim: 1 },
    });
    return applyRefundProviderUpdate({
      providerReference: refund.id || refund.refund_reference,
      providerStatus: refund.status,
      settlementId: settlement._id,
    });
  } catch (error) {
    const unambiguousProviderRejection = Boolean(error.response);
    await Settlement.findByIdAndUpdate(settlement._id, {
      $set: {
        lastError: {
          at: new Date(),
          code: String(error.code || ""),
          message: String(error.message || "Paystack refund failed").slice(0, 1000),
        },
      },
      $unset: { processingClaim: 1 },
    });
    return applyRefundProviderUpdate({
      providerReference: "",
      providerStatus: unambiguousProviderRejection ? "failed" : "needs-attention",
      settlementId: settlement._id,
    });
  }
};

const requestOrderRefund = async ({
  actorId,
  actorType,
  eventType,
  filter,
  idempotencyKey,
  now = new Date(),
  trigger,
}) => {
  const settlementKey = `refund:${filter._id}`;

  const result = await withTransaction(async (session) => {
    const existing = await Settlement.findOne({ idempotencyKey: settlementKey })
      .select("+idempotencyKey")
      .session(session);
    if (existing) {
      return {
        order: await Order.findById(filter._id).session(session),
        settlement: existing,
        wasCreated: false,
      };
    }

    const current = await Order.findOne({
      ...filter,
      activeReportId: null,
      settlementStatus: "held",
    }).session(session);
    if (!current) {
      throw httpError(409, "This order changed and can no longer be refunded automatically");
    }
    const from = stateSnapshot(current);
    const shop = await DigiShop.findById(current.shopId).session(session);
    if (!shop) throw httpError(409, "The seller account for this order is unavailable");
    const settlementSellerId = current.settlementSellerId || shop.ownerId;

    const seller = await User.findOneAndUpdate(
      {
        _id: settlementSellerId,
        "wallet.escrow": { $gte: current.totalAmount },
      },
      { $inc: { "wallet.escrow": -current.totalAmount } },
      sessionOptions(session, { new: true }),
    );
    if (!seller) {
      throw httpError(409, "Escrow balance is inconsistent; operations review is required");
    }

    const updated = await Order.findOneAndUpdate(
      {
        _id: current._id,
        activeReportId: null,
        fulfillmentStatus: current.fulfillmentStatus,
        settlementStatus: "held",
      },
      {
        $set: {
          cancelledAt: now,
          fulfillmentStatus: "cancelled",
          inventoryRestoredAt: now,
          settlementExplanation: "A refund to the original payment method is being processed.",
          settlementSellerId,
          settlementStatus: "refund_pending",
          status: "cancelled",
        },
        $unset: {
          autoReleaseAt: 1,
          workerClaim: 1,
          workflowDeadlineAt: 1,
        },
      },
      sessionOptions(session, { new: true }),
    );
    if (!updated) throw httpError(409, "This order already changed");

    const settlement = await createDocument(
      Settlement,
      {
        amount: current.totalAmount,
        currency: current.currency,
        destination: "original_payment_method",
        idempotencyKey: settlementKey,
        orderId: current._id,
        paymentTransactionId: current.paymentTransactionId,
        status: "processing",
        trigger,
        type: "refund",
      },
      session,
    );

    await createDocument(
      WalletLedgerEntry,
      {
        amount: current.totalAmount,
        balanceAfter: seller.wallet?.balance || 0,
        balanceDelta: 0,
        currency: current.currency,
        description: "Escrow removed for an original-payment-method refund",
        entryType: "escrow_refund",
        escrowAfter: seller.wallet?.escrow || 0,
        escrowDelta: -current.totalAmount,
        idempotencyKey: `ledger:${settlementKey}`,
        orderId: current._id,
        paymentTransactionId: current.paymentTransactionId,
        settlementId: settlement._id,
        userId: seller._id,
      },
      session,
    );
    await restoreInventory(updated, session);
    await appendOrderEvent({
      actorId,
      actorType,
      eventKey: normalizedIdempotencyKey({
        action: eventType,
        key: idempotencyKey,
        orderId: current._id,
        userId: actorId || "system",
      }),
      eventType: "refund_pending",
      from,
      message: "The order was cancelled and a full Paystack refund was requested.",
      order: updated,
      session,
    });
    return { order: updated, settlement, wasCreated: true };
  });

  if (!result.wasCreated) {
    await notifyLifecycleEvent(result.order, "refund_pending");
    return result;
  }

  await Promise.all([
    notifyLifecycleEvent(result.order, "refund_pending"),
    syncRestoredInventory(result.order),
  ]);

  await processRefundSettlement(result.settlement._id);
  return {
    order: await refreshParticipantOrder(result.order._id),
    settlement: await Settlement.findById(result.settlement._id),
  };
};

const releaseFunds = async ({
  actorId,
  actorType,
  eventType,
  filter,
  idempotencyKey,
  now = new Date(),
  trigger,
}) => {
  const settlementKey = `release:${filter._id}`;
  const order = await withTransaction(async (session) => {
    const existing = await Settlement.findOne({ idempotencyKey: settlementKey })
      .select("+idempotencyKey")
      .session(session);
    if (existing) return Order.findById(filter._id).session(session);

    const current = await Order.findOne({
      ...filter,
      activeReportId: null,
      settlementStatus: "held",
    }).session(session);
    if (!current) {
      throw httpError(409, "This order changed and the funds can no longer be released");
    }
    const from = stateSnapshot(current);
    const shop = await DigiShop.findById(current.shopId).session(session);
    if (!shop) throw httpError(409, "The seller account for this order is unavailable");
    const settlementSellerId = current.settlementSellerId || shop.ownerId;

    const seller = await User.findOneAndUpdate(
      {
        _id: settlementSellerId,
        "wallet.escrow": { $gte: current.totalAmount },
      },
      {
        $inc: {
          "wallet.balance": current.totalAmount,
          "wallet.escrow": -current.totalAmount,
        },
      },
      sessionOptions(session, { new: true }),
    );
    if (!seller) {
      throw httpError(409, "Escrow balance is inconsistent; operations review is required");
    }

    const updated = await Order.findOneAndUpdate(
      {
        _id: current._id,
        activeReportId: null,
        fulfillmentStatus: current.fulfillmentStatus,
        settlementStatus: "held",
      },
      {
        $set: {
          buyerConfirmedAt: actorType === "buyer" ? now : current.buyerConfirmedAt,
          completedAt: now,
          escrowStatus: "released",
          fulfillmentStatus: "completed",
          releasedAt: now,
          settledAt: now,
          settlementExplanation: "The full order total was released to the seller's Foose wallet.",
          settlementSellerId,
          settlementStatus: "released",
          status: "delivered",
        },
        $unset: {
          autoReleaseAt: 1,
          workerClaim: 1,
          workflowDeadlineAt: 1,
        },
      },
      sessionOptions(session, { new: true }),
    );
    if (!updated) throw httpError(409, "This order already changed");

    const settlement = await createDocument(
      Settlement,
      {
        amount: current.totalAmount,
        currency: current.currency,
        destination: "seller_wallet",
        idempotencyKey: settlementKey,
        orderId: current._id,
        paymentTransactionId: current.paymentTransactionId,
        processedAt: now,
        status: "processed",
        trigger,
        type: "release",
      },
      session,
    );
    await createDocument(
      WalletLedgerEntry,
      {
        amount: current.totalAmount,
        balanceAfter: seller.wallet?.balance || 0,
        balanceDelta: current.totalAmount,
        currency: current.currency,
        description: "Escrow released to seller wallet",
        entryType: "escrow_release",
        escrowAfter: seller.wallet?.escrow || 0,
        escrowDelta: -current.totalAmount,
        idempotencyKey: `ledger:${settlementKey}`,
        orderId: current._id,
        paymentTransactionId: current.paymentTransactionId,
        settlementId: settlement._id,
        userId: seller._id,
      },
      session,
    );
    await appendOrderEvent({
      actorId,
      actorType,
      eventKey: normalizedIdempotencyKey({
        action: eventType,
        key: idempotencyKey,
        orderId: current._id,
        userId: actorId || "system",
      }),
      eventType: "funds_released",
      from,
      message:
        trigger === "delivery_expiry"
          ? "Funds released automatically after the 36-hour delivery window."
          : "Funds released after the buyer confirmed the order.",
      order: updated,
      session,
    });
    return updated;
  });

  await notifyLifecycleEvent(order, "funds_released");
  return refreshParticipantOrder(order._id);
};

const confirmCollection = async ({
  idempotencyKey,
  now = new Date(),
  orderId,
  userId,
}) => {
  const participant = await loadParticipantOrder(orderId, userId);
  assertRole(participant, "buyer");
  return releaseFunds({
    actorId: userId,
    actorType: "buyer",
    eventType: "confirm_collection",
    filter: {
      _id: orderId,
      "delivery.method": "shop_pickup",
      fulfillmentStatus: "ready_for_pickup",
      pickupExpiresAt: { $gt: now },
    },
    idempotencyKey,
    now,
    trigger: "buyer_confirmation",
  });
};

const dispatchOrder = ({
  billImage,
  cargoTrackingNumber,
  idempotencyKey,
  now = new Date(),
  orderId,
  userId,
}) =>
  simpleTransition({
    action: "dispatch",
    actorId: userId,
    eventMessage: "Seller uploaded the waybill and marked the parcel sent.",
    eventType: "delivery_dispatched",
    filter: {
      _id: orderId,
      activeReportId: null,
      "delivery.method": { $in: ["station_pickup", "airport_to_airport"] },
      fulfillmentStatus: "awaiting_seller",
      settlementStatus: "held",
    },
    idempotencyKey,
    role: "seller",
    update: {
      $set: {
        autoReleaseAt: new Date(now.getTime() + DELIVERY_RELEASE_WINDOW_MS),
        deliveryReleaseAt: new Date(now.getTime() + DELIVERY_RELEASE_WINDOW_MS),
        "delivery.transit": {
          billImage,
          cargoTrackingNumber: cargoTrackingNumber || "",
        },
        fulfillmentStatus: "in_transit",
        sellerAction: "shipped",
        sellerActionAt: now,
        sentAt: now,
        status: "shipped",
        workflowDeadlineAt: new Date(now.getTime() + DELIVERY_RELEASE_WINDOW_MS),
      },
    },
  })
    .then(async (order) => {
      const stored = await Order.findById(order._id).select(
        "+delivery.transit.billImage.key",
      );
      if (
        billImage?.key &&
        stored?.delivery?.transit?.billImage?.key !== billImage.key
      ) {
        await deletePrivateObject(billImage.key).catch(() => undefined);
      }
      return order;
    })
    .catch(async (error) => {
      if (billImage?.key) {
        if (error.transitionApplied) {
          error.committedPrivateKeys = [
            ...(error.committedPrivateKeys || []),
            billImage.key,
          ];
        } else {
          try {
            const stored = await Order.findById(orderId).select(
              "+delivery.transit.billImage.key",
            );
            if (stored?.delivery?.transit?.billImage?.key === billImage.key) {
              error.committedPrivateKeys = [
                ...(error.committedPrivateKeys || []),
                billImage.key,
              ];
            } else {
              await deletePrivateObject(billImage.key).catch(() => undefined);
            }
          } catch {
            // If the verification read itself fails, preserve conservatively:
            // deleting a possibly committed bill is irreversible.
            error.committedPrivateKeys = [
              ...(error.committedPrivateKeys || []),
              billImage.key,
            ];
          }
        }
      }
      throw error;
    });

const confirmReceipt = async ({
  idempotencyKey,
  now = new Date(),
  orderId,
  userId,
}) => {
  const participant = await loadParticipantOrder(orderId, userId);
  assertRole(participant, "buyer");
  return releaseFunds({
    actorId: userId,
    actorType: "buyer",
    eventType: "confirm_receipt",
    filter: {
      _id: orderId,
      "delivery.method": { $in: ["station_pickup", "airport_to_airport"] },
      deliveryReleaseAt: { $gt: now },
      fulfillmentStatus: "in_transit",
    },
    idempotencyKey,
    now,
    trigger: "buyer_confirmation",
  });
};

const closeNoAction = async ({
  idempotencyKey,
  now = new Date(),
  orderId,
  userId,
}) => {
  const participant = await loadParticipantOrder(orderId, userId);
  assertRole(participant, "buyer");
  return requestOrderRefund({
    actorId: userId,
    actorType: "buyer",
    eventType: "close_no_action",
    filter: {
      _id: orderId,
      buyerId: userId,
      fulfillmentStatus: "awaiting_seller",
      sellerActionDeadline: { $lte: now },
    },
    idempotencyKey,
    now,
    trigger: "buyer_close",
  });
};

const refundExpiredPickup = ({ now = new Date(), orderId, workerToken }) =>
  requestOrderRefund({
    actorType: "system",
    eventType: "pickup_expiry",
    filter: {
      _id: orderId,
      "delivery.method": "shop_pickup",
      fulfillmentStatus: "ready_for_pickup",
      pickupExpiresAt: { $lte: now },
      ...(workerToken ? { "workerClaim.token": workerToken } : {}),
    },
    idempotencyKey: `worker-${orderId}`,
    now,
    trigger: "pickup_expiry",
  });

const releaseExpiredDelivery = ({ now = new Date(), orderId, workerToken }) =>
  releaseFunds({
    actorType: "system",
    eventType: "delivery_expiry",
    filter: {
      _id: orderId,
      "delivery.method": { $in: ["station_pickup", "airport_to_airport"] },
      deliveryReleaseAt: { $lte: now },
      fulfillmentStatus: "in_transit",
      ...(workerToken ? { "workerClaim.token": workerToken } : {}),
    },
    idempotencyKey: `worker-${orderId}`,
    now,
    trigger: "delivery_expiry",
  });

const submitReport = async ({
  category,
  declarationAccepted,
  detailedAccount,
  evidence = [],
  affectedItemIds = [],
  idempotencyKey,
  now = new Date(),
  orderId,
  requestedOutcome,
  userId,
}) => {
  const participant = await loadParticipantOrder(orderId, userId);
  assertRole(participant, "buyer");

  const itemIds = new Set(
    (participant.order.items || []).flatMap((item) => [
      String(item._id || ""),
      String(item.listingId?._id || item.listingId || ""),
    ]),
  );
  if (affectedItemIds.some((id) => !itemIds.has(String(id)))) {
    throw httpError(422, "A reported item does not belong to this order");
  }
  const deadline =
    participant.order.fulfillmentStatus === "ready_for_pickup"
      ? participant.order.pickupExpiresAt
      : participant.order.deliveryReleaseAt;
  if (!deadline || new Date(deadline).getTime() <= now.getTime()) {
    throw httpError(409, "The reporting window has closed");
  }

  const reportId = new mongoose.Types.ObjectId();
  const eventKey = normalizedIdempotencyKey({
    action: "report",
    key: idempotencyKey,
    orderId,
    userId,
  });

  let transitionCommitted = false;
  try {
    const result = await withTransaction(async (session) => {
      if (await actionAlreadyApplied(orderId, eventKey, session)) {
        return {
          report: await OrderReport.findOne({ orderId, isActive: true }).session(session),
          wasCreated: false,
        };
      }
      const order = await Order.findOne({
        _id: orderId,
        activeReportId: null,
        buyerId: userId,
        fulfillmentStatus: { $in: ["ready_for_pickup", "in_transit"] },
        settlementStatus: "held",
      }).session(session);
      if (!order) {
        throw httpError(409, "This order changed and can no longer be reported");
      }
      const from = stateSnapshot(order);
      const created = await createDocument(
        OrderReport,
        {
          _id: reportId,
          affectedItemIds,
          buyerId: userId,
          category,
          declarationAccepted,
          detailedAccount,
          evidence,
          frozenAt: now,
          orderId,
          requestedOutcome,
          shopId: order.shopId,
          status: "submitted",
          submittedAt: now,
        },
        session,
      );
      const updated = await Order.findOneAndUpdate(
        {
          _id: orderId,
          activeReportId: null,
          settlementStatus: "held",
        },
        {
          $set: {
            activeReportId: reportId,
            disputeReason: detailedAccount,
            settlementExplanation: "Funds are frozen while the buyer's report awaits review.",
            settlementFrozenAt: now,
            status: "disputed",
          },
          $unset: { workerClaim: 1 },
        },
        sessionOptions(session, { new: true }),
      );
      if (!updated) throw httpError(409, "This order already changed");
      await appendOrderEvent({
        actorId: userId,
        actorType: "buyer",
        eventKey,
        eventType: "order_reported",
        from,
        message: "Buyer submitted an order report and froze automatic settlement.",
        order: updated,
        session,
      });
      return { report: created, wasCreated: true };
    });

    if (!result.wasCreated) {
      await Promise.allSettled(evidence.map((file) => deletePrivateObject(file.key)));
    } else {
      transitionCommitted = true;
    }
    await notifyLifecycleEvent(orderId, "order_reported");
    return OrderReport.findById(result.report._id);
  } catch (error) {
    if (transitionCommitted) {
      error.committedPrivateKeys = [
        ...(error.committedPrivateKeys || []),
        ...evidence.map((file) => file.key),
      ];
      throw error;
    }

    let stored;
    try {
      stored = await OrderReport.findOne({ orderId, isActive: true }).select(
        "+evidence.key",
      );
    } catch {
      error.committedPrivateKeys = [
        ...(error.committedPrivateKeys || []),
        ...evidence.map((file) => file.key),
      ];
      throw error;
    }
    const storedKeys = new Set((stored?.evidence || []).map((file) => file.key));
    error.committedPrivateKeys = [
      ...(error.committedPrivateKeys || []),
      ...storedKeys,
    ];
    await Promise.allSettled(
      evidence
        .filter((file) => !storedKeys.has(file.key))
        .map((file) => deletePrivateObject(file.key)),
    );
    throw error;
  }
};

const compensateCancelledPayment = async ({ payment, providerTransaction }) => {
  const paidAt = providerPaidAt(providerTransaction);
  const compensation = await withTransaction(async (session) => {
    const currentPayment = await PaymentTransaction.findById(payment._id).session(session);
    if (!currentPayment) throw httpError(404, "Payment transaction not found");
    currentPayment.status = "paid";
    currentPayment.channel = providerTransaction.channel || currentPayment.channel;
    currentPayment.paidAt = paidAt;
    currentPayment.lastProviderEventAt = new Date();
    currentPayment.providerMetadata = providerTransaction;
    await currentPayment.save(sessionOptions(session));

    const settlements = [];
    const orders = await Order.find({
      _id: { $in: currentPayment.orderIds },
      fulfillmentStatus: "cancelled",
      inventoryRestoredAt: { $ne: null },
    }).session(session);
    if (orders.length !== currentPayment.orderIds.length) {
      throw httpError(
        409,
        "A cancelled checkout order is missing from late-payment recovery",
      );
    }
    for (const order of orders) {
      if (
        order.paymentTransactionId &&
        String(order.paymentTransactionId) !== String(currentPayment._id)
      ) {
        throw httpError(
          409,
          "A cancelled checkout order is linked to a different payment transaction",
        );
      }
      const linkResult = await Order.updateOne(
        {
          _id: order._id,
          $or: [
            { paymentTransactionId: null },
            { paymentTransactionId: currentPayment._id },
          ],
        },
        {
          $set: {
            paidAt,
            paymentRef: currentPayment.providerReference,
            paymentTransactionId: currentPayment._id,
          },
        },
        sessionOptions(session),
      );
      if (Number(linkResult.matchedCount ?? linkResult.modifiedCount ?? 0) !== 1) {
        throw httpError(
          409,
          "A cancelled checkout changed while its late payment was being linked",
        );
      }
      const settlementKey = `refund:${order._id}`;
      let settlement = await Settlement.findOne({ idempotencyKey: settlementKey })
        .select("+idempotencyKey")
        .session(session);
      if (!settlement) {
        settlement = await createDocument(
          Settlement,
          {
            amount: order.totalAmount,
            currency: order.currency,
            destination: "original_payment_method",
            idempotencyKey: settlementKey,
            orderId: order._id,
            paymentTransactionId: currentPayment._id,
            status: "processing",
            trigger: "manual_recovery",
            type: "refund",
          },
          session,
        );
        const updated = await Order.findByIdAndUpdate(
          order._id,
          {
            $set: {
              paymentStatus: "paid",
              settlementExplanation:
                "Payment completed after cancellation; an automatic refund is being processed.",
              settlementStatus: "refund_pending",
            },
          },
          sessionOptions(session, { new: true }),
        );
        await appendOrderEvent({
          actorType: "provider",
          eventKey: `late-charge:${currentPayment.providerReference}:${order._id}`,
          eventType: "late_payment_refund_started",
          from: stateSnapshot(order),
          message:
            "Paystack completed payment after checkout cancellation, so a compensating refund was started.",
          notificationType: "refund_pending",
          order: updated,
          session,
        });
      }
      settlements.push({
        id: settlement._id,
        orderId: order._id,
      });
    }
    return settlements;
  });

  for (const item of compensation) {
    // This notification path is deliberately replay-safe. If the process
    // stopped after the financial state committed but before notifying, the
    // next webhook/worker pass repairs the omission without duplicate mail.
    await notifyLifecycleEvent(item.orderId, "refund_pending");
    await processRefundSettlement(item.id);
  }
  return Order.find({ _id: { $in: payment.orderIds } });
};

const cancelExpiredPaymentReservation = async ({
  now = new Date(),
  paymentId,
  workerToken,
}) => {
  const cutoff = new Date(now.getTime() - PAYMENT_RESERVATION_WINDOW_MS);
  const restoredOrders = await withTransaction(async (session) => {
    const paymentFilter = {
      _id: paymentId,
      status: { $in: ["pending", "processing"] },
      ...(workerToken
        ? { "reconciliationClaim.token": workerToken }
        : {}),
      $or: [
        { reservationExpiresAt: { $lte: now } },
        {
          reservationExpiresAt: { $exists: false },
          initializedAt: { $lte: cutoff },
        },
      ],
    };
    const paymentQuery = PaymentTransaction.findOne(paymentFilter);
    const payment = session
      ? await paymentQuery.session(session)
      : await paymentQuery;
    if (!payment) return [];

    const ordersQuery = Order.find({ _id: { $in: payment.orderIds } });
    const orders = session ? await ordersQuery.session(session) : await ordersQuery;
    if (orders.length !== payment.orderIds.length) {
      throw httpError(
        409,
        "Expired checkout inventory cannot be restored because an order is missing",
      );
    }

    const restored = [];
    for (const order of orders) {
      if (
        order.fulfillmentStatus !== "awaiting_seller" ||
        order.settlementStatus !== "payment_pending"
      ) {
        throw httpError(
          409,
          "Expired checkout changed before inventory restoration could complete",
        );
      }
      const updated = await Order.findOneAndUpdate(
        {
          _id: order._id,
          fulfillmentStatus: "awaiting_seller",
          inventoryRestoredAt: null,
          settlementStatus: "payment_pending",
        },
        {
          $set: {
            cancelledAt: now,
            checkoutCancelledAt: now,
            escrowStatus: "not_held",
            fulfillmentStatus: "cancelled",
            inventoryRestoredAt: now,
            settlementExplanation:
              "The unpaid payment session expired and inventory was restored.",
            settlementStatus: "void",
            status: "cancelled",
          },
          $unset: { workflowDeadlineAt: 1 },
        },
        sessionOptions(session, { new: true }),
      );
      if (!updated) {
        throw httpError(409, "Checkout changed while its reservation expired");
      }
      await restoreInventory(updated, session);
      await appendOrderEvent({
        actorType: "system",
        eventKey: `payment-reservation:${payment._id}:order:${updated._id}:expired`,
        eventType: "payment_reservation_expired",
        from: stateSnapshot(order),
        message:
          "The unpaid payment session expired and its inventory was restored.",
        order: updated,
        session,
      });
      restored.push(updated);
    }

    const cancelledPayment = await PaymentTransaction.findOneAndUpdate(
      paymentFilter,
      {
        $set: {
          cancelledAt: now,
          lateChargeWatchUntil: new Date(now.getTime() + LATE_CHARGE_WATCH_MS),
          reconciliationLastAttemptAt: now,
          reconciliationLastError: "",
          status: "cancelled",
        },
        $unset: {
          reconciliationClaim: 1,
          reconciliationNextAttemptAt: 1,
        },
      },
      sessionOptions(session, { new: true }),
    );
    if (!cancelledPayment) {
      throw httpError(409, "Payment changed while its reservation expired");
    }
    return restored;
  });

  await Promise.all(
    restoredOrders.flatMap((order) => [
      notifyLifecycleEvent(order, "payment_reservation_expired"),
      syncRestoredInventory(order),
    ]),
  );
  return restoredOrders;
};

const flagPaymentValidationAttention = async ({
  error,
  now = new Date(),
  paymentId,
  providerTransaction,
}) => {
  const reason = String(
    error?.message || "Successful provider charge failed checkout validation",
  ).slice(0, 1000);
  const orders = await withTransaction(async (session) => {
    const payment = await PaymentTransaction.findOneAndUpdate(
      {
        _id: paymentId,
        status: { $in: ["cancelled", "pending", "processing"] },
      },
      {
        $set: {
          attentionAt: now,
          attentionReason: reason,
          failedAt: now,
          lastProviderEventAt: now,
          providerMetadata: providerTransaction,
          reconciliationLastError: reason,
          status: "failed",
        },
        $unset: {
          reconciliationClaim: 1,
          reconciliationNextAttemptAt: 1,
        },
      },
      sessionOptions(session, { new: true }),
    );
    if (!payment) {
      return Order.find({
        paymentTransactionId: paymentId,
      }).session(session);
    }

    const paymentOrders = await Order.find({
      _id: { $in: payment.orderIds },
    }).session(session);
    for (const order of paymentOrders) {
      if (order.activeReportId) continue;
      const reportId = new mongoose.Types.ObjectId();
      const report = await createDocument(
        OrderReport,
        {
          _id: reportId,
          affectedItemIds: (order.items || [])
            .map((item) => item._id)
            .filter(Boolean),
          buyerId: order.buyerId,
          category: "other",
          declarationAccepted: false,
          detailedAccount:
            `System safety hold: Paystack reported a successful charge, but checkout validation failed. ${reason}`.slice(
              0,
              5000,
            ),
          frozenAt: now,
          orderId: order._id,
          requestedOutcome: "other",
          shopId: order.shopId,
          source: { type: "system_payment_validation" },
          status: "submitted",
          submittedAt: now,
        },
        session,
      );
      const updated = await Order.findOneAndUpdate(
        { _id: order._id, activeReportId: null },
        {
          $set: {
            activeReportId: report._id,
            settlementExplanation:
              "A successful charge did not match the checkout record. Automatic inventory and settlement changes are frozen for operations review.",
            settlementFrozenAt: now,
          },
          $unset: {
            checkoutInitializationClaim: 1,
            workflowDeadlineAt: 1,
          },
        },
        sessionOptions(session, { new: true }),
      );
      if (!updated) continue;
      await appendOrderEvent({
        actorType: "provider",
        eventKey: `payment:${payment._id}:validation-attention:${order._id}`,
        eventType: "payment_validation_attention",
        from: stateSnapshot(order),
        message:
          "A successful provider charge failed checkout validation and entered a manual safety hold.",
        order: updated,
        session,
      });
    }
    return Order.find({ _id: { $in: payment.orderIds } }).session(session);
  });

  await Promise.all(
    orders.map((order) =>
      notifyLifecycleEvent(order, "payment_validation_attention"),
    ),
  );
  return orders;
};

const markPaymentTransactionPaid = async ({
  buyerId,
  providerReference,
  providerTransaction,
}) => {
  const payment = await PaymentTransaction.findOne({ providerReference });
  if (!payment) throw httpError(404, "Payment transaction not found");
  if (buyerId && String(payment.buyerId) !== String(buyerId)) {
    throw httpError(403, "Payment belongs to another buyer");
  }
  if (providerTransaction.status !== "success") {
    throw httpError(400, "Payment was not successful");
  }
  if (Number(providerTransaction.amount) !== Number(payment.amount)) {
    throw httpError(400, "Payment amount does not match the checkout total");
  }
  if (
    String(providerTransaction.currency || "").toUpperCase() !==
    String(payment.currency || "GHS").toUpperCase()
  ) {
    throw httpError(400, "Payment currency does not match the checkout currency");
  }
  if (
    providerTransaction.reference &&
    String(providerTransaction.reference) !== String(providerReference)
  ) {
    throw httpError(400, "Payment reference does not match");
  }

  const metadata = providerTransaction.metadata || {};
  if (metadata.buyerId && String(metadata.buyerId) !== String(payment.buyerId)) {
    throw httpError(400, "Payment metadata does not match the buyer");
  }
  if (Array.isArray(metadata.orderIds)) {
    const expected = payment.orderIds.map(String).sort();
    const supplied = metadata.orderIds.map(String).sort();
    if (expected.length !== supplied.length || expected.some((id, index) => id !== supplied[index])) {
      throw httpError(400, "Payment metadata does not match the orders");
    }
  }
  if (payment.status === "cancelled") {
    return compensateCancelledPayment({ payment, providerTransaction });
  }

  // Seller-action deadlines are anchored to Paystack's authoritative charge
  // timestamp, not webhook arrival/reconciliation time.
  const paidAt = providerPaidAt(providerTransaction);
  let cancellationWon = false;
  const updatedOrders = await withTransaction(async (session) => {
    const currentPayment = await PaymentTransaction.findById(payment._id).session(session);
    if (!currentPayment) throw httpError(404, "Payment transaction not found");
    if (currentPayment.status === "cancelled") {
      cancellationWon = true;
      return [];
    }
    if (!["pending", "processing", "paid"].includes(currentPayment.status)) {
      throw httpError(409, "Payment is no longer payable");
    }

    const orders = [];
    for (const orderId of currentPayment.orderIds) {
      const current = await Order.findById(orderId).session(session);
      if (!current) throw httpError(409, "A checkout order is missing");
      if (
        current.paymentTransactionId &&
        String(current.paymentTransactionId) !== String(currentPayment._id)
      ) {
        throw httpError(
          409,
          "A checkout order is linked to a different payment transaction",
        );
      }
      if (!current.paymentTransactionId) {
        const linkResult = await Order.updateOne(
          {
            _id: current._id,
            paymentTransactionId: null,
          },
          {
            $set: {
              paymentRef: providerReference,
              paymentTransactionId: currentPayment._id,
            },
          },
          sessionOptions(session),
        );
        if (Number(linkResult.matchedCount ?? linkResult.modifiedCount ?? 0) !== 1) {
          throw httpError(
            409,
            "A checkout order changed while its payment was being linked",
          );
        }
        current.paymentRef = providerReference;
        current.paymentTransactionId = currentPayment._id;
      }
      if (current.settlementStatus === "held") {
        orders.push(current);
        continue;
      }
      if (
        current.fulfillmentStatus !== "awaiting_seller" ||
        current.settlementStatus !== "payment_pending"
      ) {
        throw httpError(409, "A checkout order is no longer payable");
      }
      const shop = await DigiShop.findById(current.shopId).session(session);
      if (!shop) throw httpError(409, "A checkout shop is unavailable");
      const settlementSellerId = current.settlementSellerId || shop.ownerId;
      const seller = await User.findByIdAndUpdate(
        settlementSellerId,
        { $inc: { "wallet.escrow": current.totalAmount } },
        sessionOptions(session, { new: true }),
      );
      const updated = await Order.findOneAndUpdate(
        {
          _id: current._id,
          fulfillmentStatus: "awaiting_seller",
          settlementStatus: "payment_pending",
        },
        {
          $set: {
            escrowStatus: "held",
            paidAt,
            paymentMethod: "paystack",
            paymentRef: providerReference,
            paymentStatus: "paid",
            paymentTransactionId: currentPayment._id,
            sellerActionDeadline: new Date(paidAt.getTime() + SELLER_ACTION_WINDOW_MS),
            settlementExplanation: "The full order total is protected until completion or refund.",
            settlementSellerId,
            settlementStatus: "held",
            status: "paid",
            workflowDeadlineAt: new Date(paidAt.getTime() + SELLER_ACTION_WINDOW_MS),
          },
        },
        sessionOptions(session, { new: true }),
      );
      if (!updated) throw httpError(409, "A checkout order changed during payment");
      await createDocument(
        WalletLedgerEntry,
        {
          amount: current.totalAmount,
          balanceAfter: seller.wallet?.balance || 0,
          balanceDelta: 0,
          currency: current.currency,
          description: "Online payment placed in order escrow",
          entryType: "escrow_hold",
          escrowAfter: seller.wallet?.escrow || 0,
          escrowDelta: current.totalAmount,
          idempotencyKey: `ledger:hold:${current._id}`,
          orderId: current._id,
          paymentTransactionId: currentPayment._id,
          userId: seller._id,
        },
        session,
      );
      await appendOrderEvent({
        actorType: "provider",
        eventKey: `payment:${providerReference}:order:${current._id}`,
        eventType: "payment_confirmed",
        from: stateSnapshot(current),
        message: "Paystack confirmed payment and the order total entered escrow.",
        order: updated,
        session,
      });
      orders.push(updated);
    }

    currentPayment.status = "paid";
    currentPayment.channel = providerTransaction.channel || currentPayment.channel;
    currentPayment.paidAt = paidAt;
    currentPayment.lastProviderEventAt = paidAt;
    currentPayment.providerMetadata = providerTransaction;
    await currentPayment.save(sessionOptions(session));
    return orders;
  });
  if (cancellationWon) {
    const cancelledPayment = await PaymentTransaction.findById(payment._id);
    return compensateCancelledPayment({
      payment: cancelledPayment,
      providerTransaction,
    });
  }

  for (const order of updatedOrders) {
    const recommendationOrder = await Order.findOneAndUpdate(
      { _id: order._id, recommendationAwardedAt: { $exists: false } },
      { $set: { recommendationAwardedAt: new Date() } },
      { new: true },
    ).lean();
    if (recommendationOrder) {
      await awardPurchaseForOrder(recommendationOrder).catch(() => undefined);
    }
    await notifyLifecycleEvent(order, "payment_confirmed");
  }

  return updatedOrders;
};

module.exports = {
  applyRefundProviderUpdate,
  cancelCashPickup,
  cancelExpiredPaymentReservation,
  closeNoAction,
  completeCashPickup,
  compensateCancelledPayment,
  confirmCollection,
  confirmReceipt,
  dispatchOrder,
  deliverLifecycleNotificationEmail,
  flagPaymentValidationAttention,
  loadParticipantOrder,
  markPaymentTransactionPaid,
  markPickupReady,
  notifyLifecycleEvent,
  participantPopulate,
  processRefundSettlement,
  refundExpiredPickup,
  releaseExpiredDelivery,
  releaseFunds,
  releaseUnclaimedPickup,
  requestOrderRefund,
  submitReport,
  withTransaction,
};
