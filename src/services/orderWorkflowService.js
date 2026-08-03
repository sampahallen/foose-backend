const {
  FULFILLMENT_STATUSES,
  ORDER_SETTLEMENT_STATUSES,
} = require("../constants/orderLifecycle");

const asDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const deriveFulfillmentStatus = (order) => {
  if (FULFILLMENT_STATUSES.includes(order?.fulfillmentStatus)) {
    return order.fulfillmentStatus;
  }

  if (["delivered"].includes(order?.status)) return "completed";
  if (["cancelled", "refunded"].includes(order?.status)) return "cancelled";
  if (order?.sellerAction === "pickup_ready") return "ready_for_pickup";
  if (order?.sellerAction === "shipped" || order?.status === "shipped") return "in_transit";
  return "awaiting_seller";
};

const deriveSettlementStatus = (order) => {
  if (ORDER_SETTLEMENT_STATUSES.includes(order?.settlementStatus)) {
    return order.settlementStatus;
  }

  if (order?.paymentMethod === "cash_on_pickup") {
    if (deriveFulfillmentStatus(order) === "completed") return "cash_collected";
    if (deriveFulfillmentStatus(order) === "cancelled") return "void";
    return "cash_due";
  }

  if (order?.escrowStatus === "released") return "released";
  if (order?.escrowStatus === "refunded" || order?.paymentStatus === "refunded") {
    return "refunded";
  }
  if (order?.escrowStatus === "held" && order?.paymentStatus === "paid") return "held";
  return "payment_pending";
};

const ownerIdFor = (order) =>
  String(order?.shopId?.ownerId?._id || order?.shopId?.ownerId || order?.sellerId || "");

const buyerIdFor = (order) => String(order?.buyerId?._id || order?.buyerId || "");

const hasActiveReport = (order) => Boolean(order?.activeReportId);

const isBefore = (deadline, now) => {
  const at = asDate(deadline);
  return Boolean(at && at.getTime() > now.getTime());
};

const isDue = (deadline, now) => {
  const at = asDate(deadline);
  return Boolean(at && at.getTime() <= now.getTime());
};

const settlementExplanationFor = (settlementStatus) => {
  const messages = {
    payment_pending: "Payment has not been confirmed yet.",
    cash_due: "Payment is due directly to the seller at pickup.",
    cash_collected: "The seller confirmed that the item and cash changed hands.",
    held: "The full order total is protected until the order completes or is refunded.",
    released: "The full order total has been released to the seller's Foose wallet.",
    refund_pending: "A refund to the original payment method is being processed.",
    refund_attention: "The payment provider needs attention before this refund can complete.",
    refunded: "The full order total was refunded to the original payment method.",
    refund_failed: "The refund did not complete and requires operations follow-up.",
    void: "No online settlement is required for this cancelled cash order.",
  };
  return messages[settlementStatus] || "Settlement status is unavailable.";
};

const deadlineFor = (order, fulfillmentStatus, settlementStatus) => {
  if (
    fulfillmentStatus === "awaiting_seller" &&
    settlementStatus === "held" &&
    order.sellerActionDeadline
  ) {
    return {
      type: "seller_action",
      at: asDate(order.sellerActionDeadline),
      consequence: "The buyer can close the order for a full refund after this time.",
    };
  }

  if (fulfillmentStatus === "ready_for_pickup" && order.pickupExpiresAt) {
    return {
      type: "pickup_window",
      at: asDate(order.pickupExpiresAt),
      consequence:
        settlementStatus === "cash_due"
          ? "The seller can return the unclaimed item to inventory after this time."
          : "The order will be refunded and returned to inventory after this time.",
    };
  }

  if (
    fulfillmentStatus === "in_transit" &&
    settlementStatus === "held" &&
    order.deliveryReleaseAt
  ) {
    return {
      type: "delivery_confirmation",
      at: asDate(order.deliveryReleaseAt),
      consequence:
        "Funds release to the seller if the buyer neither confirms receipt nor submits a report.",
    };
  }

  return null;
};

const workflowFor = (order, userId, nowInput = new Date()) => {
  const now = asDate(nowInput) || new Date();
  const fulfillmentStatus = deriveFulfillmentStatus(order);
  const settlementStatus = deriveSettlementStatus(order);
  const isBuyer = buyerIdFor(order) === String(userId || "");
  const isSeller = ownerIdFor(order) === String(userId || "");
  const reportActive = hasActiveReport(order);
  const method = order?.delivery?.method || "station_pickup";
  const isTransitMethod = ["station_pickup", "airport_to_airport"].includes(method);
  const allowedActions = [];

  if (!reportActive) {
    if (
      isBuyer &&
      method === "shop_pickup" &&
      settlementStatus === "cash_due" &&
      fulfillmentStatus === "awaiting_seller"
    ) {
      allowedActions.push("cancel_cash_pickup");
    }

    if (
      isSeller &&
      method === "shop_pickup" &&
      fulfillmentStatus === "awaiting_seller" &&
      ["cash_due", "held"].includes(settlementStatus)
    ) {
      allowedActions.push("mark_pickup_ready");
    }

    if (
      isSeller &&
      method === "shop_pickup" &&
      settlementStatus === "cash_due" &&
      fulfillmentStatus === "ready_for_pickup"
    ) {
      allowedActions.push("complete_cash_pickup");
      if (isDue(order.pickupExpiresAt, now)) {
        allowedActions.push("release_unclaimed_pickup");
      }
    }

    if (
      isBuyer &&
      method === "shop_pickup" &&
      settlementStatus === "held" &&
      fulfillmentStatus === "ready_for_pickup" &&
      isBefore(order.pickupExpiresAt, now)
    ) {
      allowedActions.push("confirm_collection", "report");
    }

    if (
      isSeller &&
      isTransitMethod &&
      settlementStatus === "held" &&
      fulfillmentStatus === "awaiting_seller"
    ) {
      allowedActions.push("dispatch");
    }

    if (
      isBuyer &&
      settlementStatus === "held" &&
      fulfillmentStatus === "awaiting_seller" &&
      isDue(order.sellerActionDeadline, now)
    ) {
      allowedActions.push("close_no_action");
    }

    if (
      isBuyer &&
      isTransitMethod &&
      settlementStatus === "held" &&
      fulfillmentStatus === "in_transit" &&
      isBefore(order.deliveryReleaseAt, now)
    ) {
      allowedActions.push("confirm_receipt", "report");
    }
  }

  let nextActor = "none";
  if (reportActive) {
    nextActor = "review";
  } else if (["refund_attention", "refund_failed"].includes(settlementStatus)) {
    nextActor = "operations";
  } else if (settlementStatus === "refund_pending") {
    nextActor = "provider";
  } else if (fulfillmentStatus === "awaiting_seller") {
    nextActor = settlementStatus === "payment_pending"
      ? "buyer"
      : settlementStatus === "held" && isDue(order.sellerActionDeadline, now)
        ? "buyer_or_seller"
        : "seller";
  } else if (fulfillmentStatus === "ready_for_pickup") {
    nextActor =
      settlementStatus === "cash_due"
        ? "seller"
        : isDue(order.pickupExpiresAt, now)
          ? "system"
          : "buyer";
  } else if (fulfillmentStatus === "in_transit") {
    nextActor = isDue(order.deliveryReleaseAt, now) ? "system" : "buyer";
  }

  const deadline = reportActive
    ? null
    : deadlineFor(order, fulfillmentStatus, settlementStatus);
  return {
    allowedActions,
    bucket:
      reportActive
        ? "under_review"
        : ["refund_attention", "refund_failed"].includes(settlementStatus)
          ? "under_review"
          : settlementStatus === "refund_pending"
            ? "in_progress"
        : ["completed", "cancelled"].includes(fulfillmentStatus)
          ? "history"
          : allowedActions.length
            ? "needs_action"
            : "in_progress",
    deadline: deadline?.at
      ? {
          ...deadline,
          at: deadline.at.toISOString(),
        }
      : null,
    nextActor,
    primaryAction: allowedActions[0] || null,
    report: reportActive
      ? {
          active: true,
          id: String(order.activeReportId?._id || order.activeReportId),
          status: order.activeReportId?.status || "submitted",
        }
      : null,
    serverNow: now.toISOString(),
    settlementExplanation:
      order.settlementExplanation || settlementExplanationFor(settlementStatus),
  };
};

const presentOrder = (orderInput, userId, now = new Date()) => {
  const order =
    typeof orderInput?.toObject === "function"
      ? orderInput.toObject({ virtuals: true })
      : { ...orderInput };
  const fulfillmentStatus = deriveFulfillmentStatus(order);
  const settlementStatus = deriveSettlementStatus(order);

  order.fulfillmentStatus = fulfillmentStatus;
  order.settlementStatus = settlementStatus;
  order.delivery = order.delivery || {};
  const suppliedDestination = order.delivery.destination;
  const hasSuppliedDestination = [
    suppliedDestination?.recipientName,
    suppliedDestination?.recipientPhone,
    suppliedDestination?.region,
    suppliedDestination?.town,
    suppliedDestination?.preferredTerminal,
  ].some((value) => String(value || "").trim());
  if (!hasSuppliedDestination) {
    const legacyTown = [
      order.delivery?.address?.street,
      order.delivery?.address?.city,
    ]
      .filter(Boolean)
      .join(", ");
    const legacyDestination = {
      recipientName: order.delivery?.recipient?.name || "",
      recipientPhone: order.delivery?.recipient?.phone || "",
      region: order.delivery?.address?.region || "",
      town: legacyTown,
      preferredTerminal: "",
    };
    if (Object.values(legacyDestination).some((value) => String(value).trim())) {
      order.delivery.destination = legacyDestination;
    } else {
      delete order.delivery.destination;
    }
  }
  order.delivery.recipient = {
    name:
      order.delivery.destination?.recipientName ||
      order.delivery?.recipient?.name ||
      "",
    phone:
      order.delivery.destination?.recipientPhone ||
      order.delivery?.recipient?.phone ||
      "",
  };
  order.workflow = workflowFor(order, userId, now);
  return order;
};

module.exports = {
  asDate,
  deriveFulfillmentStatus,
  deriveSettlementStatus,
  presentOrder,
  settlementExplanationFor,
  workflowFor,
};
