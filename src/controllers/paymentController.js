const Order = require("../models/Order");
const User = require("../models/User");
const DigiShop = require("../models/DigiShop");
const Event = require("../models/Event");
const Listing = require("../models/Listing");
const PaymentTransaction = require("../models/PaymentTransaction");
const OrderEvent = require("../models/OrderEvent");
const Settlement = require("../models/Settlement");
const WalletLedgerEntry = require("../models/WalletLedgerEntry");
const {
  LATE_CHARGE_WATCH_MS,
} = require("../constants/orderLifecycle");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { invalidate, invalidatePattern } = require("../utils/cache");
const {
  initializeTransaction,
  toInlinePayment,
  verifyTransaction,
  verifyWebhookSignature,
} = require("../services/paystackService");
const { createNotification } = require("../services/notificationService");
const { sendSellerOrderEmail } = require("../services/emailService");
const { awardPurchaseForOrder } = require("../services/recommendationService");
const { runSearchSync, syncListingSearchDocument } = require("../services/searchIndexService");
const {
  createPromotionOrder,
  fulfilPromotionOrder,
  tierConfig,
  uniqueIds,
  loadEligibleTargets,
} = require("../services/promotionService");
const {
  applyRefundProviderUpdate,
  markPaymentTransactionPaid,
  withTransaction,
} = require("../services/orderLifecycleService");
const { presentOrder } = require("../services/orderWorkflowService");

const orderPopulate = [
  { path: "shopId", select: "ownerId shopName slug" },
  { path: "buyerId", select: "name username email phone isKycVerified" },
  { path: "items.listingId", select: "title images price currency type" },
];

const encodeLedgerCursor = (entry) =>
  Buffer.from(
    JSON.stringify({
      createdAt: new Date(entry.createdAt).toISOString(),
      id: String(entry._id),
    }),
  ).toString("base64url");

const decodeLedgerCursor = (cursor) => {
  try {
    const parsed = JSON.parse(
      Buffer.from(String(cursor), "base64url").toString("utf8"),
    );
    if (!/^[a-f0-9]{24}$/i.test(parsed.id)) return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
};

const ledgerOrderContext = (order, userId, serverNow) => {
  if (!order) return null;
  const presented = presentOrder(order, userId, serverNow);
  const items = presented.items || [];
  const firstTitle =
    items[0]?.title || items[0]?.listingId?.title || "Order item";
  return {
    currency: presented.currency,
    deliveryMethod: presented.delivery?.method || null,
    fulfillmentStatus: presented.fulfillmentStatus,
    id: String(presented._id),
    itemCount: items.reduce(
      (total, item) => total + Math.max(Number(item.quantity || 1), 1),
      0,
    ),
    itemSummary:
      items.length > 1 ? `${firstTitle} + ${items.length - 1} more` : firstTitle,
    settlementStatus: presented.settlementStatus,
    shortReference: String(presented._id).slice(-8).toUpperCase(),
    totalAmount: presented.totalAmount,
    workflow: presented.workflow,
  };
};

const PROMOTION_CONFIG = {
  event: {
    tags: ["featured", "home-featured", "home-banner"],
    packages: {
      basic: { amount: 1000, amountGhs: 10, durationDays: 7, label: "Basic featured event promotion" },
      lite: { amount: 3000, amountGhs: 30, durationDays: 30, label: "Lite featured event promotion" },
      premium: { amount: 7000, amountGhs: 70, durationDays: 90, label: "Premium featured event promotion" },
    },
  },
  listing: {
    tags: ["top-pick"],
    packages: {
      basic: { amount: 1000, amountGhs: 10, durationDays: 3, itemLimit: 10, label: "Basic Top Pick listing bundle" },
      lite: { amount: 3000, amountGhs: 30, durationDays: 7, itemLimit: 15, label: "Lite Top Pick listing bundle" },
      premium: { amount: 5000, amountGhs: 50, durationDays: 30, itemLimit: 30, label: "Premium Top Pick listing bundle" },
    },
  },
};

const promotionPackage = (targetType, packageName = "basic") => {
  const targetConfig = PROMOTION_CONFIG[targetType];
  const packageConfig = targetConfig?.packages?.[packageName] || targetConfig?.packages?.basic;
  if (!targetConfig || !packageConfig) return null;
  return {
    ...packageConfig,
    packageName: targetConfig.packages[packageName] ? packageName : "basic",
    tags: targetConfig.tags,
  };
};

const addUniqueTags = (currentTags, nextTags) =>
  Array.from(new Set([...(currentTags || []), ...nextTags].map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)));

const listingTargetIds = (targetId, targetIds) => {
  const ids = Array.isArray(targetIds) ? targetIds : targetIds ? [targetIds] : [];
  if (targetId) ids.push(targetId);
  return Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean)));
};

const loadPromotionTarget = async ({ targetId, targetIds, targetType, userId, itemLimit }) => {
  if (targetType === "listing") {
    const shop = await DigiShop.findOne({ ownerId: userId }).select("_id");
    if (!shop) throw httpError(403, "A DigiShop is required to promote listings");

    const ids = listingTargetIds(targetId, targetIds);
    if (!ids.length) throw httpError(422, "Choose at least one listing to promote");
    if (itemLimit && ids.length > itemLimit) {
      throw httpError(422, `This package supports up to ${itemLimit} listings`);
    }

    const listings = await Listing.find({
      _id: { $in: ids },
      shopId: shop._id,
      status: { $ne: "removed" },
    });
    if (listings.length !== ids.length) throw httpError(404, "One or more listings could not be found");

    return { targets: listings };
  }

  if (targetType === "event") {
    const event = await Event.findOne({ _id: targetId, organizerId: userId });
    if (!event) throw httpError(404, "Event not found");

    const endsAt = event.endsAt || event.date;
    if (endsAt && new Date(endsAt) < new Date()) {
      throw httpError(422, "Past events cannot be promoted");
    }

    return { target: event };
  }

  throw httpError(422, "Choose a valid promotion target");
};

const ensurePaymentTransaction = async ({ orders, reference, transaction }) => {
  let payment = await PaymentTransaction.findOne({ providerReference: reference });
  if (payment) return payment;

  const amount = orders.reduce((sum, order) => sum + Number(order.totalAmount), 0);
  payment = await PaymentTransaction.create({
    amount,
    buyerId: orders[0].buyerId,
    currency: orders[0].currency || "GHS",
    orderIds: orders.map((order) => order._id),
    providerMetadata: transaction,
    providerReference: reference,
    status: "pending",
  });
  await Order.updateMany(
    { _id: { $in: orders.map((order) => order._id) } },
    { $set: { paymentTransactionId: payment._id } },
  );
  return payment;
};

exports.cancelPayment = asyncHandler(async (req, res) => {
  const reference = req.params.reference;
  const orders = await Order.find({
    buyerId: req.user.id,
    paymentRef: reference,
  });

  if (!orders.length) throw httpError(404, "Pending payment not found");

  const transaction = await verifyTransaction(reference);
  if (transaction.status === "success") {
    await ensurePaymentTransaction({ orders, reference, transaction });
    const paidOrders = await markPaymentTransactionPaid({
      buyerId: req.user.id,
      providerReference: reference,
      providerTransaction: transaction,
    });
    if (
      paidOrders.length &&
      paidOrders.every((order) => order.fulfillmentStatus === "cancelled")
    ) {
      return success(
        res,
        {
          cancelled: true,
          orders: paidOrders,
          paid: true,
          refundPending: paidOrders.some((order) =>
            ["refund_pending", "refund_attention", "refund_failed"].includes(
              order.settlementStatus,
            )),
          releasedItemCount: 0,
        },
        "Payment completed after cancellation and a compensating refund was started",
      );
    }
    if (paidOrders.some((order) => order?.paymentStatus !== "paid")) {
      throw httpError(409, "Payment completed after cancellation; contact support with the payment reference");
    }
    return success(res, { cancelled: false, paid: true, releasedItemCount: 0, orders: paidOrders }, "Payment was already completed");
  }

  const now = new Date();
  const { cancelledOrders, releasedQuantities } = await withTransaction(async (session) => {
    const cancelled = [];
    const released = new Map();

    for (const order of orders) {
      const cancelledOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          buyerId: req.user.id,
          paymentRef: reference,
          paymentStatus: "unpaid",
          status: "pending",
        },
        {
          $set: {
            cancelledAt: now,
            checkoutCancelledAt: now,
            escrowStatus: "not_held",
            fulfillmentStatus: "cancelled",
            inventoryRestoredAt: now,
            settlementStatus: "void",
            status: "cancelled",
          },
          $unset: { workflowDeadlineAt: 1 },
        },
        { new: true, ...(session ? { session } : {}) },
      );
      if (!cancelledOrder) continue;
      cancelled.push(cancelledOrder);
      for (const item of cancelledOrder.items) {
        if (!item.listingId) {
          throw httpError(
            409,
            `Inventory restoration for order ${cancelledOrder._id} requires operations attention`,
          );
        }
        const listingId = String(item.listingId);
        const quantity = Math.max(Number(item.quantity || 1), 1);
        released.set(listingId, (released.get(listingId) || 0) + quantity);
        const inventoryUpdate = await Listing.updateOne(
          { _id: listingId },
          [
            {
              $set: {
                quantity: {
                  $add: [{ $ifNull: ["$quantity", 0] }, quantity],
                },
                status: {
                  $cond: [
                    { $eq: ["$status", "sold"] },
                    "active",
                    "$status",
                  ],
                },
              },
            },
          ],
          session ? { session } : undefined,
        );
        if (
          Number(
            inventoryUpdate.matchedCount ?? inventoryUpdate.modifiedCount ?? 0,
          ) !== 1
        ) {
          throw httpError(
            409,
            `Inventory restoration for order ${cancelledOrder._id} could not find listing ${listingId}`,
          );
        }
      }
      await OrderEvent.create(
        [
          {
            actorId: req.user.id,
            actorType: "buyer",
            eventKey: `payment-cancel:${reference}:order:${cancelledOrder._id}`,
            eventType: "payment_cancelled",
            from: {
              fulfillmentStatus: order.fulfillmentStatus,
              settlementStatus: order.settlementStatus,
            },
            message:
              "Buyer cancelled the unpaid checkout and its inventory was restored.",
            orderId: cancelledOrder._id,
            to: {
              fulfillmentStatus: cancelledOrder.fulfillmentStatus,
              settlementStatus: cancelledOrder.settlementStatus,
            },
          },
        ],
        session ? { session } : undefined,
      );
    }
    if (cancelled.length && cancelled.length !== orders.length) {
      throw httpError(409, "Checkout state changed while cancellation was in progress");
    }
    if (cancelled.length) {
      const paymentQuery = PaymentTransaction.findOne({
        providerReference: reference,
      });
      const payment = session
        ? await paymentQuery.session(session)
        : await paymentQuery;
      let paymentId;
      if (payment) {
        const paymentCancellation = await PaymentTransaction.updateOne(
          {
            _id: payment._id,
            status: { $in: ["pending", "processing"] },
          },
          {
            $set: {
              cancelledAt: now,
              lateChargeWatchUntil: new Date(
                now.getTime() + LATE_CHARGE_WATCH_MS,
              ),
              status: "cancelled",
            },
          },
          session ? { session } : undefined,
        );
        if (
          Number(
            paymentCancellation.matchedCount ??
              paymentCancellation.modifiedCount ??
              0,
          ) !== 1
        ) {
          throw httpError(409, "Payment completed before cancellation could win");
        }
        paymentId = payment._id;
      } else {
        const [createdPayment] = await PaymentTransaction.create(
          [
            {
              amount: orders.reduce(
                (total, order) => total + Number(order.totalAmount),
                0,
              ),
              buyerId: req.user.id,
              cancelledAt: now,
              currency: orders[0].currency || "GHS",
              lateChargeWatchUntil: new Date(
                now.getTime() + LATE_CHARGE_WATCH_MS,
              ),
              orderIds: orders.map((order) => order._id),
              providerReference: reference,
              status: "cancelled",
            },
          ],
          session ? { session } : undefined,
        );
        paymentId = createdPayment._id;
      }
      await Order.updateMany(
        { _id: { $in: cancelled.map((order) => order._id) } },
        {
          $set: { paymentTransactionId: paymentId },
        },
        session ? { session } : undefined,
      );
    }
    return { cancelledOrders: cancelled, releasedQuantities: released };
  });

  await Promise.all(
    Array.from(releasedQuantities.keys()).map((listingId) =>
      runSearchSync(`listing:${listingId}:payment-cancelled`, () =>
        syncListingSearchDocument(listingId)),
    ),
  );

  await invalidate(
    "listings:featured",
    ...cancelledOrders.map((order) => `shop:${order.shopId}:listings`),
  );

  const currentOrders = cancelledOrders.length
    ? cancelledOrders
    : await Order.find({ buyerId: req.user.id, paymentRef: reference });
  const alreadyCancelled = !cancelledOrders.length && currentOrders.every((order) => order.status === "cancelled");
  if (!cancelledOrders.length && !alreadyCancelled) {
    throw httpError(409, "Payment can no longer be cancelled");
  }

  return success(
    res,
    {
      cancelled: true,
      orderIds: orders.map((order) => order._id),
      paid: false,
      releasedItemCount: Array.from(releasedQuantities.values()).reduce((sum, quantity) => sum + quantity, 0),
    },
    alreadyCancelled ? "Payment was already cancelled" : "Payment cancelled and inventory released",
  );
});

exports.initializePayment = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.body.orderId,
    buyerId: req.user.id,
  });
  if (!order) throw httpError(404, "Order not found");
  if (order.paymentMethod === "cash_on_pickup") {
    throw httpError(400, "Cash pickup orders do not use online payment initialization");
  }
  if (!order.paymentTransactionId) {
    throw httpError(
      409,
      "This checkout has no grouped payment session; retry the original checkout request",
    );
  }
  const payment = await PaymentTransaction.findOne({
    _id: order.paymentTransactionId,
    buyerId: req.user.id,
  }).select("+providerMetadata");
  if (!payment) throw httpError(404, "Payment transaction not found");
  const providerMetadata = payment.providerMetadata || {};
  return success(
    res,
    {
      payment: providerMetadata.access_code
        ? toInlinePayment(providerMetadata)
        : {
            provider: "paystack",
            reference: payment.providerReference,
            status: payment.status,
          },
    },
    "Existing grouped payment loaded",
  );
});

exports.getPaymentStatus = asyncHandler(async (req, res) => {
  const transaction = await verifyTransaction(req.params.reference);
  const orders = await Order.find({
    paymentRef: req.params.reference,
    buyerId: req.user.id,
  });

  if (!orders.length) throw httpError(404, "Order not found for reference");
  const populatedOrders = await Order.find({ _id: { $in: orders.map((order) => order._id) } })
    .populate(orderPopulate)
    .sort({ createdAt: -1 });
  return success(
    res,
    {
      order: presentOrder(populatedOrders[0], req.user.id),
      orders: populatedOrders.map((order) => presentOrder(order, req.user.id)),
      transaction,
    },
    "Payment status loaded",
  );
});

exports.verifyPayment = asyncHandler(async (req, res) => {
  const transaction = await verifyTransaction(req.params.reference);
  const orders = await Order.find({
    paymentRef: req.params.reference,
    buyerId: req.user.id,
  });

  if (!orders.length) throw httpError(404, "Order not found for reference");
  await ensurePaymentTransaction({
    orders,
    reference: req.params.reference,
    transaction,
  });
  await markPaymentTransactionPaid({
    buyerId: req.user.id,
    providerReference: req.params.reference,
    providerTransaction: transaction,
  });

  const populatedOrders = await Order.find({ _id: { $in: orders.map((order) => order._id) } })
    .populate(orderPopulate)
    .sort({ createdAt: -1 });

  return success(
    res,
    {
      order: presentOrder(populatedOrders[0], req.user.id),
      orders: populatedOrders.map((order) => presentOrder(order, req.user.id)),
      transaction,
    },
    "Payment verified",
  );
});

exports.initializePromotionPayment = asyncHandler(async (req, res) => {
  const targetType = req.body.targetType;
  const targetId = req.body.targetId;
  if (req.body.tier) {
    const config = tierConfig(req.body.tier, targetType);
    if (!config) throw httpError(422, "Choose a valid promotion tier");
    const targetIds = uniqueIds([...(req.body.targetIds || []), ...(targetId ? [targetId] : [])]);
    await loadEligibleTargets({ ownerId: req.user.id, targetIds, targetType });
    const totalAmount = config.unitAmount * targetIds.length;
    const transaction = await initializeTransaction({
      callbackUrl: req.body.callbackUrl,
      email: req.user.email,
      amount: totalAmount,
      metadata: {
        durationHours: config.durationHours,
        purpose: "promotion",
        promotionVersion: 2,
        targetIds,
        targetType,
        tier: req.body.tier,
        unitAmount: config.unitAmount,
        userId: req.user.id,
      },
    });
    const order = await createPromotionOrder({
      ownerId: req.user.id,
      paymentReference: transaction.reference,
      targetIds,
      targetType,
      tier: req.body.tier,
      validated: true,
    });
    return success(res, {
      payment: {
        ...toInlinePayment(transaction),
        amount: totalAmount,
        amountGhs: totalAmount / 100,
        durationHours: config.durationHours,
        promotionOrderId: order._id,
        targetIds,
        targetType,
        tier: req.body.tier,
        unitAmount: config.unitAmount,
      },
    }, "Promotion payment initialized");
  }
  const config = promotionPackage(targetType, req.body.packageName);

  if (!config) throw httpError(422, "Choose listing or event promotion");

  const targetIds = listingTargetIds(targetId, req.body.targetIds);
  await loadPromotionTarget({ targetId, targetIds, targetType, userId: req.user.id, itemLimit: config.itemLimit });

  const transaction = await initializeTransaction({
    callbackUrl: req.body.callbackUrl,
    email: req.user.email,
    amount: config.amount,
    metadata: {
      amount: config.amount,
      amountGhs: config.amountGhs,
      label: config.label,
      packageName: config.packageName,
      purpose: "promotion",
      targetId,
      targetIds: targetType === "listing" ? targetIds : undefined,
      targetType,
      userId: req.user.id,
    },
  });

  return success(
    res,
    {
      payment: {
        ...toInlinePayment(transaction),
        amount: config.amount,
        amountGhs: config.amountGhs,
        targetId,
        targetIds: targetType === "listing" ? targetIds : undefined,
        targetType,
        packageName: config.packageName,
      },
    },
    "Promotion payment initialized",
  );
});

exports.verifyPromotionPayment = asyncHandler(async (req, res) => {
  const transaction = await verifyTransaction(req.params.reference);

  const promotionOrder = await fulfilPromotionOrder({ transaction, userId: req.user.id });
  if (promotionOrder) {
    return success(res, {
      promotion: promotionOrder,
      targetType: promotionOrder.targetType,
    }, "Promotion verified and activated");
  }

  if (transaction.status !== "success") {
    throw httpError(400, "Promotion payment was not successful");
  }

  const metadata = transaction.metadata || {};
  const targetType = metadata.targetType;
  const targetId = metadata.targetId;
  const targetIds = listingTargetIds(targetId, metadata.targetIds);
  const config = promotionPackage(targetType, metadata.packageName);

  if (!config || metadata.purpose !== "promotion") {
    throw httpError(400, "Payment reference is not for a promotion");
  }

  if (String(metadata.userId) !== String(req.user.id)) {
    throw httpError(403, "Promotion payment belongs to another user");
  }

  if (Number(transaction.amount || 0) < config.amount) {
    throw httpError(400, "Promotion payment amount does not match the selected campaign");
  }

  const { target, targets } = await loadPromotionTarget({
    itemLimit: config.itemLimit,
    targetId,
    targetIds,
    targetType,
    userId: req.user.id,
  });

  if (targetType === "listing") {
    const now = new Date();
    await Promise.all(
      targets.map(async (listing) => {
        const activeUntil =
          listing.promotionExpiresAt && listing.promotionExpiresAt > now
            ? new Date(listing.promotionExpiresAt)
            : now;
        listing.promotionTags = addUniqueTags(listing.promotionTags, config.tags);
        listing.promotionExpiresAt = new Date(activeUntil.getTime() + config.durationDays * 24 * 60 * 60 * 1000);
        await listing.save();
        await invalidate("listings:featured", `listing:${listing._id}`, `shop:${listing.shopId}:listings`);
      }),
    );
    await invalidatePattern("search:top-picks:*");

    return success(
      res,
      {
        listing: targets[0],
        listings: targets,
        promotion: {
          amountGhs: config.amountGhs,
          endsAt: targets[0]?.promotionExpiresAt,
          itemLimit: config.itemLimit,
          packageName: config.packageName,
          reference: req.params.reference,
        },
        targetType,
      },
      "Listing promotion verified",
    );
  }

  target.promotionTags = addUniqueTags(target.promotionTags, config.tags);
  const now = new Date();
  const activeUntil =
    target.promotionExpiresAt && target.promotionExpiresAt > now
      ? new Date(target.promotionExpiresAt)
      : now;
  const requestedEndsAt = new Date(activeUntil.getTime() + config.durationDays * 24 * 60 * 60 * 1000);
  const eventEndsAt = target.endsAt || target.date;
  target.promotionExpiresAt = eventEndsAt && new Date(eventEndsAt) < requestedEndsAt ? new Date(eventEndsAt) : requestedEndsAt;
  await target.save();
  await invalidate("events:feed", "events:upcoming", "events:featured", `event:${target._id}`);

  return success(
    res,
    {
      event: target,
      promotion: {
        amountGhs: config.amountGhs,
        endsAt: target.promotionExpiresAt,
        packageName: config.packageName,
        reference: req.params.reference,
      },
      targetType,
    },
    "Event promotion verified",
  );
});

const processPaystackWebhook = async (payload) => {
  const event = String(payload.event || "");
  const data = payload.data || {};

  if (event === "charge.success") {
    await fulfilPromotionOrder({ transaction: data });
    const orders = await Order.find({ paymentRef: data.reference });
    if (!orders.length) return;
    await ensurePaymentTransaction({
      orders,
      reference: data.reference,
      transaction: data,
    });
    await markPaymentTransactionPaid({
      providerReference: data.reference,
      providerTransaction: data,
    });
    return;
  }

  if (!event.startsWith("refund.")) return;
  const refundProviderReference = String(
    data.id || data.refund_reference || "",
  ).trim();
  let settlement = refundProviderReference
    ? await Settlement.findOne({
        providerReference: refundProviderReference,
        type: "refund",
      })
    : null;

  if (!settlement) {
    const transactionData = data.transaction || {};
    const providerTransactionId =
      typeof transactionData === "object" ? transactionData.id : transactionData;
    const providerTransactionReference =
      typeof transactionData === "object"
        ? transactionData.reference || data.transaction_reference
        : data.transaction_reference;
    const paymentCandidates = [
      ...(providerTransactionId
        ? [{ "providerMetadata.id": providerTransactionId }]
        : []),
      ...(providerTransactionReference
        ? [{ providerReference: providerTransactionReference }]
        : []),
    ];
    const payment = paymentCandidates.length
      ? await PaymentTransaction.findOne({ $or: paymentCandidates }).select(
          "+providerMetadata",
        )
      : null;
    const noteOrderId = String(data.merchant_note || "").match(
      /Foose order ([a-f0-9]{24})/i,
    )?.[1];
    const refundCurrency = String(data.currency || "").trim().toUpperCase();
    const refundAmount = Number(data.amount);
    if (
      payment &&
      refundCurrency &&
      Number.isFinite(refundAmount) &&
      refundAmount > 0
    ) {
      const settlementCandidates = await Settlement.find({
        amount: refundAmount,
        currency: refundCurrency,
        paymentTransactionId: payment._id,
        type: "refund",
        ...(noteOrderId ? { orderId: noteOrderId } : {}),
      })
        .sort({ createdAt: 1 })
        .limit(2);
      /*
       * Paystack refund webhooks may omit merchant_note and may send a null
       * refund_reference while the refund is still pending. In that case,
       * correlate only when the payment/amount/currency tuple identifies one
       * settlement across the transaction's entire history. Including already
       * processed settlements prevents a replay for refund A from being
       * mistaken for the sole still-pending equal-amount refund B.
       */
      if (settlementCandidates.length === 1) {
        [settlement] = settlementCandidates;
      }
    }
  }

  if (settlement) {
    await applyRefundProviderUpdate({
      providerReference: refundProviderReference,
      providerStatus: data.status || event.replace("refund.", ""),
      settlementId: settlement._id,
    });
  }
};

exports.webhook = asyncHandler(async (req, res) => {
  const rawBody = req.rawBody || JSON.stringify(req.body);
  const signature = req.headers["x-paystack-signature"];
  if (!verifyWebhookSignature(rawBody, signature)) {
    throw httpError(401, "Invalid Paystack signature");
  }

  if (req.body.event === "charge.success") {
    const data = req.body.data || {};
    const orders = await Order.find({ paymentRef: data.reference });
    if (orders.length) {
      const payment = await ensurePaymentTransaction({
        orders,
        reference: data.reference,
        transaction: data,
      });
      await PaymentTransaction.updateOne(
        { _id: payment._id, status: { $in: ["pending", "processing"] } },
        {
          $set: {
            lastProviderEventAt: new Date(),
            "providerMetadata.lastWebhook": data,
            status: "processing",
          },
        },
      );
    } else {
      /*
       * Promotion fulfillment has no PaymentTransaction queue. Complete that
       * idempotent database path before acknowledgement.
       */
      await fulfilPromotionOrder({ transaction: data });
    }
  }

  /*
   * Paystack retries when acknowledgement is slow. Signature verification is
   * synchronous; charges are durably claimed above, while refund settlements
   * already exist before Paystack can emit their events. The worker reconciles
   * both payment transactions and refunds if this process exits after the ack.
   */
  const response = success(res, {}, "Webhook received");
  setImmediate(() => {
    void processPaystackWebhook(req.body).catch((error) => {
      console.error(`Paystack webhook processing failed: ${error.message}`);
    });
  });
  return response;
});

exports.getWalletLedger = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50);
  const filter = { userId: req.user.id };
  if (req.query.type) filter.entryType = req.query.type;

  if (req.query.cursor) {
    const cursor = decodeLedgerCursor(req.query.cursor);
    if (!cursor) throw httpError(422, "Invalid wallet ledger cursor");
    filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ];
  }

  const rows = await WalletLedgerEntry.find(filter)
    .populate({
      path: "orderId",
      populate: [
        { path: "shopId", select: "ownerId shopName slug" },
        { path: "activeReportId", select: "status" },
      ],
      select:
        "activeReportId currency delivery fulfillmentStatus items settlementExplanation settlementStatus totalAmount",
    })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const serverNow = new Date();
  const entries = page.map((entry) => ({
    amount: entry.amount,
    balanceAfter: entry.balanceAfter ?? null,
    balanceDelta: entry.balanceDelta,
    createdAt: entry.createdAt,
    currency: entry.currency,
    description: entry.description,
    entryType: entry.entryType,
    escrowAfter: entry.escrowAfter ?? null,
    escrowDelta: entry.escrowDelta,
    id: String(entry._id),
    order: ledgerOrderContext(entry.orderId, req.user.id, serverNow),
  }));

  return success(
    res,
    {
      entries,
      hasMore,
      nextCursor: hasMore ? encodeLedgerCursor(page[page.length - 1]) : null,
      serverNow: serverNow.toISOString(),
    },
    "Wallet activity loaded",
  );
});

exports.withdraw = asyncHandler(async (req, res) => {
  throw httpError(
    410,
    "Wallet withdrawals are temporarily unavailable while the idempotent withdrawal workflow is being rebuilt",
  );
});
