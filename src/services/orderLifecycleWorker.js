const crypto = require("crypto");
const Order = require("../models/Order");
const OrderEvent = require("../models/OrderEvent");
const Notification = require("../models/Notification");
const PaymentTransaction = require("../models/PaymentTransaction");
const Settlement = require("../models/Settlement");
const User = require("../models/User");
const {
  LATE_CHARGE_WATCH_MS,
  PAYMENT_RESERVATION_WINDOW_MS,
} = require("../constants/orderLifecycle");
const { categoryEmailEnabled, createNotification } = require("./notificationService");
const { sendOrderLifecycleEmail } = require("./emailService");
const { verifyTransaction } = require("./paystackService");
const {
  cancelExpiredPaymentReservation,
  deliverLifecycleNotificationEmail,
  flagPaymentValidationAttention,
  markPaymentTransactionPaid,
  notifyLifecycleEvent,
  processRefundSettlement,
  refundExpiredPickup,
  releaseExpiredDelivery,
} = require("./orderLifecycleService");

const DEFAULT_INTERVAL_MS = 60 * 1000;
const CLAIM_TTL_MS = 2 * 60 * 1000;
const PAYMENT_RECONCILIATION_BATCH_SIZE = 25;
let intervalHandle;
let sweepRunning = false;

const isOrderLifecycleWorkerEnabled = (env = process.env) =>
  env.NODE_ENV !== "test" &&
  String(env.ORDER_LIFECYCLE_WORKER_ENABLED || "").toLowerCase() === "true";

const claimDueOrder = (now) => {
  const token = crypto.randomUUID();
  return Order.findOneAndUpdate(
    {
      activeReportId: null,
      settlementStatus: "held",
      $and: [
        {
          $or: [
            { "workerClaim.until": { $exists: false } },
            { "workerClaim.until": { $lte: now } },
          ],
        },
        {
          $or: [
            {
              "delivery.method": "shop_pickup",
              fulfillmentStatus: "ready_for_pickup",
              pickupExpiresAt: { $lte: now },
            },
            {
              "delivery.method": { $in: ["station_pickup", "airport_to_airport"] },
              deliveryReleaseAt: { $lte: now },
              fulfillmentStatus: "in_transit",
            },
          ],
        },
      ],
    },
    {
      $set: {
        "workerClaim.token": token,
        "workerClaim.until": new Date(now.getTime() + CLAIM_TTL_MS),
      },
    },
    {
      new: true,
      sort: { workflowDeadlineAt: 1, _id: 1 },
    },
  )
    .select("+workerClaim.token")
    .then((order) => (order ? { order, token } : null));
};

const clearClaim = (orderId, token) =>
  Order.updateOne(
    { _id: orderId, "workerClaim.token": token },
    { $unset: { workerClaim: 1 } },
  );

const claimPendingNotificationEvent = (now) => {
  const token = crypto.randomUUID();
  return OrderEvent.findOneAndUpdate(
    {
      notificationDispatchedAt: null,
      notificationRequired: true,
      $and: [
        {
          $or: [
            { notificationNextAttemptAt: { $exists: false } },
            { notificationNextAttemptAt: null },
            { notificationNextAttemptAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { "notificationClaim.until": { $exists: false } },
            { "notificationClaim.until": null },
            { "notificationClaim.until": { $lte: now } },
          ],
        },
      ],
    },
    {
      $inc: { notificationAttemptCount: 1 },
      $set: {
        notificationLastAttemptAt: now,
        "notificationClaim.token": token,
        "notificationClaim.until": new Date(now.getTime() + CLAIM_TTL_MS),
      },
    },
    {
      new: true,
      sort: { notificationNextAttemptAt: 1, createdAt: 1, _id: 1 },
    },
  )
    .select("+notificationClaim.token")
    .then((event) => (event ? { event, token } : null));
};

const reconcileOrderEventNotifications = async (now = new Date()) => {
  for (let index = 0; index < 50; index += 1) {
    const claim = await claimPendingNotificationEvent(now);
    if (!claim) break;
    const { event, token } = claim;
    try {
      await notifyLifecycleEvent(
        event.orderId,
        event.notificationType || event.eventType,
      );
    } catch (error) {
      const attempts = Math.max(Number(event.notificationAttemptCount || 1), 1);
      const backoffMs = Math.min(
        60 * 60 * 1000,
        60 * 1000 * 2 ** Math.min(attempts - 1, 6),
      );
      await OrderEvent.updateOne(
        { _id: event._id, "notificationClaim.token": token },
        {
          $set: {
            notificationLastError: String(
              error.message || "Order notification delivery failed",
            ).slice(0, 500),
            notificationNextAttemptAt: new Date(now.getTime() + backoffMs),
          },
          $unset: { notificationClaim: 1 },
        },
      ).catch(() => undefined);
    }
  }
};

const deliverEligibilityNotification = async ({
  body,
  claimField,
  emailField,
  eventKey,
  finalField,
  inAppField,
  lastErrorField,
  order,
  title,
  user,
}) => {
  if (!user?._id) return;
  const now = new Date();
  const token = crypto.randomUUID();
  const claim = await Order.findOneAndUpdate(
    {
      _id: order._id,
      [finalField]: null,
      $or: [
        { [`${claimField}.until`]: { $exists: false } },
        { [`${claimField}.until`]: null },
        { [`${claimField}.until`]: { $lte: now } },
      ],
    },
    {
      $inc: {
        [
          finalField === "sellerDeadlineNotifiedAt"
            ? "sellerDeadlineNotificationAttemptCount"
            : "pickupExpiryNotificationAttemptCount"
        ]: 1,
      },
      $set: {
        [`${claimField}.token`]: token,
        [`${claimField}.until`]: new Date(now.getTime() + CLAIM_TTL_MS),
      },
    },
    { new: true },
  );
  if (!claim) return;

  let inAppSent = Boolean(claim[inAppField]);
  let emailSent = Boolean(claim[emailField]);
  const errors = [];

  if (!inAppSent) {
    try {
      await createNotification({
        body,
        eventKey,
        link: `/orders/${order._id}`,
        title,
        type: "order",
        userId: user._id,
      });
      await Order.updateOne(
        { _id: order._id, [`${claimField}.token`]: token },
        { $set: { [inAppField]: now } },
      );
      inAppSent = true;
    } catch (error) {
      errors.push(error);
    }
  }

  if (!emailSent) {
    // A disabled "order" email preference finalizes this leg as done (not
    // retried) rather than being skipped silently, which would otherwise
    // leave emailSent permanently false and retry forever.
    if (!(await categoryEmailEnabled(user._id, "order"))) {
      await Order.updateOne(
        { _id: order._id, [`${claimField}.token`]: token },
        { $set: { [emailField]: now } },
      );
      emailSent = true;
    } else {
      try {
        await sendOrderLifecycleEmail({
          message: body,
          order,
          subject: title,
          user,
        });
        await Order.updateOne(
          { _id: order._id, [`${claimField}.token`]: token },
          { $set: { [emailField]: now } },
        );
        emailSent = true;
      } catch (error) {
        errors.push(error);
      }
    }
  }

  if (inAppSent && emailSent) {
    await Order.updateOne(
      { _id: order._id, [`${claimField}.token`]: token },
      {
        $set: { [finalField]: now, [lastErrorField]: "" },
        $unset: { [claimField]: 1 },
      },
    );
    return;
  }

  await Order.updateOne(
    { _id: order._id, [`${claimField}.token`]: token },
    {
      $set: {
        [`${claimField}.until`]: new Date(now.getTime() + 60 * 1000),
        [lastErrorField]: errors
          .map((error) => error.message || "Notification delivery failed")
          .join("; ")
          .slice(0, 500),
      },
      $unset: { [`${claimField}.token`]: 1 },
    },
  );
};

const notifyNewlyEligibleActions = async (now) => {
  const [sellerDeadlines, cashPickupDeadlines] = await Promise.all([
    Order.find({
      activeReportId: null,
      fulfillmentStatus: "awaiting_seller",
      sellerDeadlineNotifiedAt: null,
      sellerActionDeadline: { $lte: now },
      settlementStatus: "held",
      $and: [
        {
          $or: [
            { "sellerDeadlineNotificationClaim.until": { $exists: false } },
            { "sellerDeadlineNotificationClaim.until": null },
            { "sellerDeadlineNotificationClaim.until": { $lte: now } },
          ],
        },
      ],
    })
      .populate("buyerId", "_id name username email")
      .limit(100),
    Order.find({
      "delivery.method": "shop_pickup",
      fulfillmentStatus: "ready_for_pickup",
      pickupExpiryNotifiedAt: null,
      pickupExpiresAt: { $lte: now },
      settlementStatus: "cash_due",
      $and: [
        {
          $or: [
            { "pickupExpiryNotificationClaim.until": { $exists: false } },
            { "pickupExpiryNotificationClaim.until": null },
            { "pickupExpiryNotificationClaim.until": { $lte: now } },
          ],
        },
      ],
    })
      .populate("shopId", "ownerId")
      .limit(100),
  ]);

  for (const order of sellerDeadlines) {
    const user = order.buyerId;
    await deliverEligibilityNotification({
      body:
        "The seller preparation window passed. You may close this order for a full refund.",
      claimField: "sellerDeadlineNotificationClaim",
      emailField: "sellerDeadlineNotificationEmailAt",
      eventKey: `order:${order._id}:close_no_action:eligible`,
      finalField: "sellerDeadlineNotifiedAt",
      inAppField: "sellerDeadlineNotificationInAppAt",
      lastErrorField: "sellerDeadlineNotificationLastError",
      order,
      title: "You can close this order",
      user,
    });
  }
  for (const order of cashPickupDeadlines) {
    const user = await User.findById(order.shopId?.ownerId).select(
      "_id name username email",
    );
    if (!user) continue;
    await deliverEligibilityNotification({
      body:
        "The 72-hour pickup window passed. You may return the unclaimed item to inventory.",
      claimField: "pickupExpiryNotificationClaim",
      emailField: "pickupExpiryNotificationEmailAt",
      eventKey: `order:${order._id}:release_unclaimed_pickup:eligible`,
      finalField: "pickupExpiryNotifiedAt",
      inAppField: "pickupExpiryNotificationInAppAt",
      lastErrorField: "pickupExpiryNotificationLastError",
      order,
      title: "Pickup window expired",
      user,
    });
  }
};

const reconcileRefunds = async () => {
  const settlements = await Settlement.find({
    type: "refund",
    $or: [
      { status: { $in: ["pending", "processing", "failed"] } },
      {
        providerReference: { $ne: "" },
        status: "needs_attention",
      },
    ],
  })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(25);

  for (const settlement of settlements) {
    await processRefundSettlement(settlement._id).catch((error) => {
      console.warn(`Refund reconciliation ${settlement._id} failed: ${error.message}`);
    });
  }
};

const reconcileLifecycleEmails = async () => {
  const now = new Date();
  const notifications = await Notification.find({
    type: "order",
    eventKey: { $type: "string" },
    lifecycleEmailRequired: true,
    lifecycleEmailSentAt: null,
    $or: [
      { "lifecycleEmailClaim.until": { $exists: false } },
      { "lifecycleEmailClaim.until": null },
      { "lifecycleEmailClaim.until": { $lte: now } },
    ],
  })
    .select(
      "+eventKey +lifecycleEmailAttemptCount +lifecycleEmailClaim.until +lifecycleEmailSentAt",
    )
    .populate("userId", "_id name username email")
    .sort({ lifecycleEmailLastAttemptAt: 1, createdAt: 1, _id: 1 })
    .limit(25);

  for (const notification of notifications) {
    const orderId = String(notification.link || "").match(
      /\/orders\/([a-f0-9]{24})(?:\/|$)/i,
    )?.[1];
    if (!orderId) continue;
    const order = await Order.findById(orderId);
    if (!order) continue;
    await deliverLifecycleNotificationEmail({
      notification,
      order,
      user: notification.userId,
    });
  }
};

const claimPendingPayment = (now) => {
  const token = crypto.randomUUID();
  return PaymentTransaction.findOneAndUpdate(
    {
      /*
       * Cancelled reservations remain reconcilable because a successful
       * Paystack charge can arrive after the local cancellation won. The paid
       * handler turns that late charge into an idempotent compensating refund.
       */
      $or: [
        { status: { $in: ["pending", "processing"] } },
        {
          lateChargeWatchUntil: { $gt: now },
          status: "cancelled",
        },
      ],
      $and: [
        {
          $or: [
            { reconciliationNextAttemptAt: { $exists: false } },
            { reconciliationNextAttemptAt: null },
            { reconciliationNextAttemptAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { "reconciliationClaim.until": { $exists: false } },
            { "reconciliationClaim.until": null },
            { "reconciliationClaim.until": { $lte: now } },
          ],
        },
      ],
    },
    {
      $set: {
        "reconciliationClaim.token": token,
        "reconciliationClaim.until": new Date(now.getTime() + CLAIM_TTL_MS),
      },
    },
    {
      new: true,
      sort: { reconciliationNextAttemptAt: 1, initializedAt: 1, _id: 1 },
    },
  )
    .select("+reconciliationClaim.token")
    .then((payment) => (payment ? { payment, token } : null));
};

const finishPaymentReconciliationAttempt = async ({
  error,
  now,
  payment,
  token,
}) => {
  const attempts = Number(payment.reconciliationAttemptCount || 0) + 1;
  const backoffMs = Math.min(
    payment.status === "cancelled"
      ? Math.min(LATE_CHARGE_WATCH_MS, 24 * 60 * 60 * 1000)
      : 60 * 60 * 1000,
    60 * 1000 * 2 ** Math.min(attempts - 1, 6),
  );
  await PaymentTransaction.updateOne(
    { _id: payment._id, "reconciliationClaim.token": token },
    {
      $inc: { reconciliationAttemptCount: 1 },
      $set: {
        reconciliationLastAttemptAt: now,
        reconciliationLastError: error
          ? String(error.message || "Payment reconciliation failed").slice(0, 500)
          : "",
        reconciliationNextAttemptAt: new Date(now.getTime() + backoffMs),
      },
      $unset: { reconciliationClaim: 1 },
    },
  );
};

const reconcilePendingPayments = async (now = new Date()) => {
  for (
    let index = 0;
    index < PAYMENT_RECONCILIATION_BATCH_SIZE;
    index += 1
  ) {
    const claim = await claimPendingPayment(now);
    if (!claim) break;
    const { payment, token } = claim;
    let attemptError = null;
    try {
      const transaction = await verifyTransaction(payment.providerReference);
      if (transaction.status === "success") {
        try {
          await markPaymentTransactionPaid({
            providerReference: payment.providerReference,
            providerTransaction: transaction,
          });
        } catch (error) {
          if (Number(error.statusCode || error.status) === 400) {
            await flagPaymentValidationAttention({
              error,
              now,
              paymentId: payment._id,
              providerTransaction: transaction,
            });
          } else {
            throw error;
          }
        }
      } else {
        const reservationExpiresAt =
          payment.reservationExpiresAt ||
          new Date(
            new Date(payment.initializedAt).getTime() +
              PAYMENT_RESERVATION_WINDOW_MS,
          );
        if (
          payment.status !== "cancelled" &&
          !Number.isNaN(new Date(reservationExpiresAt).getTime()) &&
          new Date(reservationExpiresAt).getTime() <= now.getTime()
        ) {
          await cancelExpiredPaymentReservation({
            now,
            paymentId: payment._id,
            workerToken: token,
          });
        }
      }
    } catch (error) {
      attemptError = error;
      console.warn(
        `Payment reconciliation ${payment.providerReference} failed: ${error.message}`,
      );
    } finally {
      await finishPaymentReconciliationAttempt({
        error: attemptError,
        now,
        payment,
        token,
      }).catch((error) => {
        console.warn(
          `Payment reconciliation claim ${payment.providerReference} failed: ${error.message}`,
        );
      });
    }
  }
};

const runLifecycleSweep = async ({ batchSize = 100, now = new Date() } = {}) => {
  if (sweepRunning) return { skipped: true };
  sweepRunning = true;
  let processed = 0;

  try {
    for (let index = 0; index < batchSize; index += 1) {
      const claim = await claimDueOrder(now);
      if (!claim) break;
      const { order, token } = claim;
      let succeeded = false;

      try {
        if (
          order.delivery?.method === "shop_pickup" &&
          order.fulfillmentStatus === "ready_for_pickup"
        ) {
          await refundExpiredPickup({
            now,
            orderId: order._id,
            workerToken: token,
          });
        } else {
          await releaseExpiredDelivery({
            now,
            orderId: order._id,
            workerToken: token,
          });
        }
        processed += 1;
        succeeded = true;
      } catch (error) {
        console.warn(`Order lifecycle job ${order._id} failed: ${error.message}`);
        const failureCount = Number(order.workerClaim?.failureCount || 0) + 1;
        const backoffMs = Math.min(
          60 * 60 * 1000,
          60 * 1000 * 2 ** Math.min(failureCount - 1, 6),
        );
        await Order.updateOne(
          { _id: order._id, "workerClaim.token": token },
          {
            $inc: { "workerClaim.failureCount": 1 },
            $set: {
              "workerClaim.lastError": String(error.message || "Lifecycle job failed").slice(
                0,
                500,
              ),
              "workerClaim.until": new Date(now.getTime() + backoffMs),
            },
            $unset: { "workerClaim.token": 1 },
          },
        ).catch(() => undefined);
      } finally {
        if (succeeded) {
          await clearClaim(order._id, token).catch(() => undefined);
        }
      }
    }

    await Promise.all([
      notifyNewlyEligibleActions(now),
      reconcileLifecycleEmails(),
      reconcileOrderEventNotifications(now),
      reconcilePendingPayments(now),
      reconcileRefunds(),
    ]);
    return { processed, skipped: false };
  } finally {
    sweepRunning = false;
  }
};

const startOrderLifecycleWorker = () => {
  if (intervalHandle || !isOrderLifecycleWorkerEnabled()) {
    return intervalHandle;
  }

  void runLifecycleSweep().catch((error) => {
    console.warn(`Initial order lifecycle sweep failed: ${error.message}`);
  });
  intervalHandle = setInterval(() => {
    void runLifecycleSweep().catch((error) => {
      console.warn(`Order lifecycle sweep failed: ${error.message}`);
    });
  }, Math.max(Number(process.env.ORDER_LIFECYCLE_WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS, 5000));
  intervalHandle.unref?.();
  return intervalHandle;
};

const stopOrderLifecycleWorker = () => {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = undefined;
};

module.exports = {
  isOrderLifecycleWorkerEnabled,
  reconcileOrderEventNotifications,
  reconcilePendingPayments,
  runLifecycleSweep,
  startOrderLifecycleWorker,
  stopOrderLifecycleWorker,
};
