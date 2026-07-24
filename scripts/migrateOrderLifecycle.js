const path = require("path");

const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const DigiShop = require("../src/models/DigiShop");
const Order = require("../src/models/Order");
const OrderEvent = require("../src/models/OrderEvent");
const OrderReport = require("../src/models/OrderReport");
const PaymentTransaction = require("../src/models/PaymentTransaction");
const Settlement = require("../src/models/Settlement");
const {
  DELIVERY_RELEASE_WINDOW_MS,
  PICKUP_WINDOW_MS,
  SELLER_ACTION_WINDOW_MS,
} = require("../src/constants/orderLifecycle");

const MIGRATION_VERSION = 1;
const dryRun = process.argv.includes("--dry-run");

const legacyOrderFilter = {
  $or: [
    { fulfillmentStatus: { $exists: false } },
    { settlementStatus: { $exists: false } },
  ],
};

const asDate = (value) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const addMilliseconds = (value, milliseconds) => {
  const date = asDate(value);
  return date ? new Date(date.getTime() + milliseconds) : undefined;
};

const isCashOrder = (order) =>
  order.paymentMethod === "cash_on_pickup" ||
  order.paymentStatus === "cash_on_pickup";

const inferFulfillmentStatus = (order) => {
  if (["cancelled", "refunded"].includes(order.status)) return "cancelled";
  if (order.status === "delivered") return "completed";
  if (order.sellerAction === "shipped" || order.status === "shipped") {
    return "in_transit";
  }
  if (order.sellerAction === "pickup_ready") return "ready_for_pickup";
  return "awaiting_seller";
};

const inferSettlement = (order, fulfillmentStatus) => {
  if (isCashOrder(order)) {
    if (fulfillmentStatus === "completed") {
      return { settlementStatus: "cash_collected" };
    }
    if (fulfillmentStatus === "cancelled") {
      return { settlementStatus: "void" };
    }
    return {
      settlementStatus: "cash_due",
      requiresManualReview: order.status === "disputed",
      note:
        order.status === "disputed"
          ? "Legacy cash-pickup dispute retained for manual review; no escrow was created."
          : "",
    };
  }

  if (
    order.paymentStatus === "refunded" ||
    order.escrowStatus === "refunded" ||
    order.status === "refunded"
  ) {
    return {
      settlementStatus: "refunded",
      requiresManualReview: Boolean(order.status === "disputed"),
      note:
        order.status === "disputed"
          ? "Legacy dispute was already marked refunded."
          : "",
    };
  }

  if (order.escrowStatus === "released") {
    return {
      settlementStatus: "released",
      requiresManualReview: order.status === "disputed",
      note:
        order.status === "disputed"
          ? "Legacy dispute was raised after escrow had already been released."
          : "",
    };
  }

  if (order.paymentStatus === "paid") {
    const ambiguous =
      order.status === "cancelled" ||
      order.escrowStatus !== "held" ||
      order.status === "disputed" ||
      fulfillmentStatus === "completed";

    return {
      settlementStatus: "held",
      requiresManualReview: ambiguous,
      note: ambiguous
        ? "Paid legacy order has no safe terminal settlement; funds remain held for manual review."
        : "",
    };
  }

  if (order.escrowStatus === "held") {
    return {
      settlementStatus: "held",
      requiresManualReview: true,
      note:
        "Legacy payment and escrow fields disagree; the apparent escrow remains frozen for manual review.",
    };
  }

  if (fulfillmentStatus === "cancelled") {
    return { settlementStatus: "void" };
  }

  return {
    settlementStatus: "payment_pending",
    requiresManualReview:
      order.status === "disputed" || order.escrowStatus === "held",
    note:
      order.status === "disputed" || order.escrowStatus === "held"
        ? "Legacy payment and escrow fields disagree; no money was moved by the migration."
        : "",
  };
};

const transactionStatusForOrders = (orders) => {
  const refunded = orders.filter(
    (order) =>
      order.paymentStatus === "refunded" ||
      order.escrowStatus === "refunded" ||
      order.status === "refunded",
  );

  if (refunded.length === orders.length) return "refunded";
  if (refunded.length) return "partially_refunded";
  if (
    orders.some(
      (order) =>
        order.paymentStatus === "paid" ||
        order.escrowStatus === "held" ||
        order.escrowStatus === "released",
    )
  ) {
    return "paid";
  }
  if (orders.every((order) => order.status === "cancelled")) return "cancelled";
  return "pending";
};

const loadLegacyPaymentGroups = async () => {
  const cursor = Order.collection.aggregate([
    {
      $match: {
        ...legacyOrderFilter,
        paymentRef: { $type: "string", $ne: "" },
        paymentMethod: { $ne: "cash_on_pickup" },
      },
    },
    {
      $group: {
        _id: "$paymentRef",
        orders: {
          $push: {
            _id: "$_id",
            buyerId: "$buyerId",
            currency: "$currency",
            escrowStatus: "$escrowStatus",
            paidAt: "$paidAt",
            paymentStatus: "$paymentStatus",
            status: "$status",
            totalAmount: "$totalAmount",
          },
        },
      },
    },
  ]);

  return cursor.toArray();
};

const migratePaymentTransactions = async (counters) => {
  const transactionIds = new Map();
  const groups = await loadLegacyPaymentGroups();

  for (const group of groups) {
    const orders = group.orders || [];
    if (!orders.length) continue;

    counters.paymentTransactions += 1;
    if (dryRun) continue;

    const amount = orders.reduce(
      (sum, order) => sum + Math.max(Number(order.totalAmount || 0), 0),
      0,
    );
    if (amount <= 0) {
      counters.paymentTransactionsSkipped += 1;
      continue;
    }

    const refundedAmount = orders
      .filter(
        (order) =>
          order.paymentStatus === "refunded" ||
          order.escrowStatus === "refunded" ||
          order.status === "refunded",
      )
      .reduce(
        (sum, order) => sum + Math.max(Number(order.totalAmount || 0), 0),
        0,
      );
    const paidDates = orders.map((order) => asDate(order.paidAt)).filter(Boolean);
    const buyerIds = [
      ...new Set(orders.map((order) => String(order.buyerId || ""))),
    ];
    const currencies = [
      ...new Set(
        orders.map((order) => String(order.currency || "GHS").toUpperCase()),
      ),
    ];
    const groupRequiresManualReview =
      buyerIds.length !== 1 || currencies.length !== 1;
    const migratedAt = new Date();

    const transaction = await PaymentTransaction.findOneAndUpdate(
      { providerReference: group._id },
      {
        $setOnInsert: {
          amount,
          buyerId: orders[0].buyerId,
          currency: orders[0].currency || "GHS",
          initializedAt: paidDates.length
            ? new Date(Math.min(...paidDates.map((date) => date.getTime())))
            : migratedAt,
          legacyMigratedAt: migratedAt,
          orderIds: orders.map((order) => order._id),
          paidAt: paidDates.length
            ? new Date(Math.min(...paidDates.map((date) => date.getTime())))
            : undefined,
          provider: "paystack",
          providerMetadata: {
            buyerIdMismatch: buyerIds.length > 1,
            currencyMismatch: currencies.length > 1,
            migrationVersion: MIGRATION_VERSION,
          },
          providerReference: group._id,
          refundedAmount,
          source: "legacy_migration",
          status: transactionStatusForOrders(orders),
        },
      },
      {
        new: true,
        setDefaultsOnInsert: true,
        upsert: true,
      },
    ).select("_id providerReference");

    transactionIds.set(group._id, {
      id: transaction._id,
      requiresManualReview: groupRequiresManualReview,
    });
  }

  return transactionIds;
};

const ensureLegacyReport = async (order, frozenAt, counters) => {
  counters.reports += 1;
  if (dryRun) return null;

  const filter = {
    "source.legacyOrderId": order._id,
  };
  const now = new Date();
  const reason = String(order.disputeReason || "").trim();
  const detailedAccount =
    reason.length >= 20
      ? reason
      : order.status === "disputed"
        ? `Legacy dispute record: ${reason || "No detailed reason was recorded."}`
        : "Legacy settlement safety hold: the existing financial state requires manual review.";

  try {
    await OrderReport.collection.updateOne(
      filter,
      {
        $setOnInsert: {
          affectedItemIds: (order.items || [])
            .map((item) => item?._id)
            .filter(Boolean)
            .slice(0, 100),
          buyerId: order.buyerId,
          category: "other",
          createdAt: asDate(order.updatedAt) || now,
          declarationAccepted: false,
          detailedAccount: detailedAccount.slice(0, 5000),
          evidence: [],
          frozenAt,
          isActive: true,
          orderId: order._id,
          requestedOutcome: "other",
          shopId: order.shopId,
          source: {
            legacyOrderId: order._id,
            type: "legacy_migration",
          },
          status: "submitted",
          submittedAt: frozenAt,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  return OrderReport.collection.findOne(
    {
      $or: [
        filter,
        { orderId: order._id, isActive: true },
      ],
    },
    { projection: { _id: 1, frozenAt: 1 } },
  );
};

const ensureHistoricalSettlement = async (
  order,
  settlementStatus,
  paymentTransactionId,
  counters,
) => {
  if (!["released", "refunded"].includes(settlementStatus)) return;

  const amount = Math.max(Number(order.totalAmount || 0), 0);
  if (amount < 1) return;

  counters.settlements += 1;
  if (dryRun) return;

  const isRefund = settlementStatus === "refunded";
  const processedAt =
    asDate(
      isRefund
        ? order.disputeResolvedAt || order.updatedAt
        : order.releasedAt || order.updatedAt,
    ) || new Date();

  await Settlement.collection.updateOne(
    {
      idempotencyKey: `legacy:v${MIGRATION_VERSION}:order:${order._id}:${isRefund ? "refund" : "release"}`,
    },
    {
      $setOnInsert: {
        amount,
        createdAt: processedAt,
        currency: order.currency || "GHS",
        destination: isRefund
          ? "buyer_wallet_legacy"
          : "seller_wallet",
        idempotencyKey: `legacy:v${MIGRATION_VERSION}:order:${order._id}:${isRefund ? "refund" : "release"}`,
        orderId: order._id,
        paymentTransactionId,
        processedAt,
        ...(isRefund ? { accountingAppliedAt: processedAt } : {}),
        providerReference: "",
        providerStatus: "legacy_recorded",
        status: "processed",
        trigger: "legacy_migration",
        type: isRefund ? "refund" : "release",
        updatedAt: processedAt,
      },
    },
    { upsert: true },
  );
};

const ensureMigrationEvent = async (
  order,
  fulfillmentStatus,
  settlementStatus,
  counters,
) => {
  counters.events += 1;
  if (dryRun) return;

  const timestamp = new Date();
  await OrderEvent.collection.updateOne(
    {
      eventKey: `legacy:v${MIGRATION_VERSION}:migrated`,
      orderId: order._id,
    },
    {
      $setOnInsert: {
        actorType: "migration",
        createdAt: timestamp,
        eventKey: `legacy:v${MIGRATION_VERSION}:migrated`,
        eventType: "legacy_migrated",
        message: "Legacy order state mapped to the lifecycle state machine.",
        metadata: {
          legacyEscrowStatus: order.escrowStatus,
          legacyPaymentStatus: order.paymentStatus,
          legacySellerAction: order.sellerAction,
          legacyStatus: order.status,
          migrationVersion: MIGRATION_VERSION,
        },
        orderId: order._id,
        to: {
          fulfillmentStatus,
          settlementStatus,
        },
      },
    },
    { upsert: true },
  );
};

const lifecycleUpdateForOrder = ({
  order,
  fulfillmentStatus,
  settlement,
  paymentTransactionId,
  report,
  settlementSellerId,
}) => {
  const createdAt = asDate(order.createdAt) || new Date();
  const paidAt = asDate(order.paidAt);
  const readyAt =
    fulfillmentStatus === "ready_for_pickup"
      ? asDate(order.readyAt || order.sellerActionAt || order.updatedAt) ||
        createdAt
      : undefined;
  const sentAt =
    fulfillmentStatus === "in_transit"
      ? asDate(order.sentAt || order.sellerActionAt || order.updatedAt) ||
        createdAt
      : undefined;
  const sellerDeadlineAnchor = isCashOrder(order) ? createdAt : paidAt;
  const canHaveSellerDeadline =
    fulfillmentStatus === "awaiting_seller" &&
    (isCashOrder(order) || order.paymentStatus === "paid");
  const completedAt =
    fulfillmentStatus === "completed"
      ? asDate(
          order.completedAt ||
            order.buyerConfirmedAt ||
            order.releasedAt ||
            order.updatedAt,
        ) || createdAt
      : undefined;
  const cancelledAt =
    fulfillmentStatus === "cancelled"
      ? asDate(order.cancelledAt || order.checkoutCancelledAt || order.updatedAt) ||
        createdAt
      : undefined;
  const settledAt = ["released", "refunded", "cash_collected"].includes(
    settlement.settlementStatus,
  )
    ? asDate(
        order.settledAt ||
          order.releasedAt ||
          order.disputeResolvedAt ||
          order.buyerConfirmedAt ||
          order.updatedAt,
      ) || createdAt
    : undefined;

  const update = {
    fulfillmentStatus,
    "lifecycleMigration.migratedAt": new Date(),
    "lifecycleMigration.note": settlement.note || "",
    "lifecycleMigration.requiresManualReview": Boolean(
      settlement.requiresManualReview,
    ),
    "lifecycleMigration.version": MIGRATION_VERSION,
    settlementExplanation:
      settlement.note ||
      {
        cash_collected: "The seller confirmed collection and cash receipt.",
        cash_due: "Payment is due directly to the seller at pickup.",
        held: "The full order total remains protected in escrow.",
        payment_pending: "Payment has not been confirmed yet.",
        refunded: "The legacy order was recorded as refunded.",
        released: "The legacy order funds were released to the seller.",
        void: "No online settlement is required for this cancelled order.",
      }[settlement.settlementStatus] ||
      "",
    settlementStatus: settlement.settlementStatus,
  };

  if (paymentTransactionId) update.paymentTransactionId = paymentTransactionId;
  if (settlementSellerId) update.settlementSellerId = settlementSellerId;
  if (report?._id) {
    update.activeReportId = report._id;
    update.settlementFrozenAt = asDate(report.frozenAt) || new Date();
  }
  if (canHaveSellerDeadline && sellerDeadlineAnchor) {
    update.sellerActionDeadline = addMilliseconds(
      sellerDeadlineAnchor,
      SELLER_ACTION_WINDOW_MS,
    );
  }
  if (readyAt) {
    update.readyAt = readyAt;
    update.pickupExpiresAt = addMilliseconds(readyAt, PICKUP_WINDOW_MS);
  }
  if (sentAt) {
    update.sentAt = sentAt;
    update.deliveryReleaseAt = addMilliseconds(
      sentAt,
      DELIVERY_RELEASE_WINDOW_MS,
    );
  }
  if (!report?._id) {
    const workflowDeadlineAt =
      update.deliveryReleaseAt ||
      update.pickupExpiresAt ||
      update.sellerActionDeadline ||
      (settlement.settlementStatus === "cash_due" &&
      fulfillmentStatus === "awaiting_seller"
        ? asDate(order.createdAt)
        : undefined);
    if (workflowDeadlineAt) update.workflowDeadlineAt = workflowDeadlineAt;
  }
  if (completedAt) update.completedAt = completedAt;
  if (cancelledAt) update.cancelledAt = cancelledAt;
  if (settledAt) update.settledAt = settledAt;
  if (order.checkoutCancelledAt) {
    // The legacy payment-cancellation path restored inventory atomically with
    // checkout cancellation. Other terminal paths are intentionally not guessed.
    update.inventoryRestoredAt = asDate(order.checkoutCancelledAt);
  }
  if (order.delivery?.address) {
    update["delivery.destination.region"] =
      order.delivery.address.region || "";
    update["delivery.destination.town"] =
      order.delivery.address.city || "";
  }

  return update;
};

const migrateOrders = async (transactionIds, counters) => {
  const cursor = Order.collection.find(legacyOrderFilter);
  const shopOwnerCache = new Map();

  for await (const order of cursor) {
    counters.orders += 1;

    const fulfillmentStatus = inferFulfillmentStatus(order);
    let settlement = inferSettlement(order, fulfillmentStatus);
    const transactionInfo = transactionIds.get(order.paymentRef);
    const paymentTransactionId = transactionInfo?.id || transactionInfo;
    if (
      transactionInfo?.requiresManualReview &&
      !isCashOrder(order) &&
      !["refunded", "released", "void"].includes(settlement.settlementStatus)
    ) {
      settlement = {
        settlementStatus: "held",
        requiresManualReview: true,
        note:
          "Legacy orders sharing this payment reference disagree on buyer or currency; settlement remains frozen for manual review.",
      };
    }
    const shouldCreateReport =
      settlement.settlementStatus === "held" &&
      settlement.requiresManualReview;
    const frozenAt =
      asDate(order.updatedAt || order.sellerActionAt || order.createdAt) ||
      new Date();
    const report = shouldCreateReport
      ? await ensureLegacyReport(order, frozenAt, counters)
      : null;

    await ensureHistoricalSettlement(
      order,
      settlement.settlementStatus,
      paymentTransactionId,
      counters,
    );
    await ensureMigrationEvent(
      order,
      fulfillmentStatus,
      settlement.settlementStatus,
      counters,
    );

    if (dryRun) continue;

    const shopKey = String(order.shopId || "");
    let settlementSellerId = order.settlementSellerId;
    if (!settlementSellerId && shopKey) {
      if (!shopOwnerCache.has(shopKey)) {
        const shop = await DigiShop.findById(order.shopId).select("ownerId").lean();
        shopOwnerCache.set(shopKey, shop?.ownerId || null);
      }
      settlementSellerId = shopOwnerCache.get(shopKey);
    }

    const update = lifecycleUpdateForOrder({
      fulfillmentStatus,
      order,
      paymentTransactionId,
      report,
      settlement,
      settlementSellerId,
    });

    await Order.collection.updateOne(
      {
        _id: order._id,
        "lifecycleMigration.version": { $ne: MIGRATION_VERSION },
      },
      { $set: update },
    );
  }
};

const backfillSettlementSellers = async (counters) => {
  const cursor = Order.collection.find(
    { settlementSellerId: { $exists: false } },
    { projection: { shopId: 1 } },
  );
  const shopOwnerCache = new Map();
  for await (const order of cursor) {
    const shopKey = String(order.shopId || "");
    if (!shopKey) continue;
    if (!shopOwnerCache.has(shopKey)) {
      const shop = await DigiShop.findById(order.shopId).select("ownerId").lean();
      shopOwnerCache.set(shopKey, shop?.ownerId || null);
    }
    const ownerId = shopOwnerCache.get(shopKey);
    if (!ownerId) continue;
    counters.settlementSellers += 1;
    if (!dryRun) {
      await Order.collection.updateOne(
        { _id: order._id, settlementSellerId: { $exists: false } },
        { $set: { settlementSellerId: ownerId } },
      );
    }
  }
};

const run = async () => {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

  const counters = {
    events: 0,
    orders: 0,
    paymentTransactions: 0,
    paymentTransactionsSkipped: 0,
    reports: 0,
    settlements: 0,
    settlementSellers: 0,
  };

  try {
    await connectDB();
    const transactionIds = await migratePaymentTransactions(counters);
    await backfillSettlementSellers(counters);
    await migrateOrders(transactionIds, counters);

    const prefix = dryRun ? "Order lifecycle migration dry run" : "Order lifecycle migration";
    console.log(
      `${prefix} complete: ${counters.orders} order(s), ${counters.paymentTransactions} payment transaction(s), ${counters.reports} report(s), ${counters.settlements} settlement(s), ${counters.events} event(s), ${counters.paymentTransactionsSkipped} invalid transaction group(s) skipped`,
    );
  } finally {
    await mongoose.connection.close();
  }
};

if (require.main === module) {
  run().catch((error) => {
    console.error(`Order lifecycle migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  inferFulfillmentStatus,
  inferSettlement,
  lifecycleUpdateForOrder,
  transactionStatusForOrders,
};
