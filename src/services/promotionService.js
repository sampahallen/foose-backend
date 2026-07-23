const DigiShop = require("../models/DigiShop");
const Event = require("../models/Event");
const Listing = require("../models/Listing");
const PromotionOrder = require("../models/PromotionOrder");
const PromotionMetricEvent = require("../models/PromotionMetricEvent");
const httpError = require("../utils/httpError");
const { invalidate, invalidatePattern } = require("../utils/cache");

const MAX_LISTINGS_PER_ORDER = 30;
const PROMOTION_TIERS = Object.freeze({
  quick_boost: { targetType: "listing", label: "Quick Boost", unitAmount: 1000, durationHours: 24 },
  weekend_push: { targetType: "listing", label: "Weekend Push", unitAmount: 3000, durationHours: 72 },
  top_pick: { targetType: "listing", label: "Top Pick", unitAmount: 5000, durationHours: 168 },
  homepage_feature: { targetType: "event", label: "Homepage Feature", unitAmount: 3000, durationHours: 168 },
});

const uniqueIds = (ids) => Array.from(new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean)));

const tierConfig = (tier, targetType) => {
  const config = PROMOTION_TIERS[tier];
  return config?.targetType === targetType ? config : null;
};

const loadEligibleTargets = async ({ ownerId, targetIds, targetType }) => {
  const ids = uniqueIds(targetIds);
  if (!ids.length) throw httpError(422, targetType === "event" ? "Choose an event to promote" : "Choose at least one listing to promote");

  if (targetType === "listing") {
    if (ids.length > MAX_LISTINGS_PER_ORDER) throw httpError(422, `Choose up to ${MAX_LISTINGS_PER_ORDER} listings`);
    const shop = await DigiShop.findOne({ ownerId }).select("_id");
    if (!shop) throw httpError(403, "A DigiShop is required to promote listings");
    const targets = await Listing.find({ _id: { $in: ids }, shopId: shop._id, status: "active" }).select("+promotionReferences");
    if (targets.length !== ids.length) throw httpError(404, "One or more active listings could not be found");
    return targets;
  }

  if (ids.length !== 1) throw httpError(422, "Choose one event to promote");
  const event = await Event.findOne({ _id: ids[0], organizerId: ownerId }).select("+promotionReferences");
  if (!event) throw httpError(404, "Event not found");
  const endsAt = event.endsAt || event.date;
  if (endsAt && new Date(endsAt) <= new Date()) throw httpError(422, "Past events cannot be promoted");
  return [event];
};

const createPromotionOrder = async ({ ownerId, paymentReference, targetIds, targetType, tier, validated = false }) => {
  const config = tierConfig(tier, targetType);
  if (!config) throw httpError(422, "Choose a valid promotion tier");
  const ids = uniqueIds(targetIds);
  if (!validated) await loadEligibleTargets({ ownerId, targetIds: ids, targetType });
  return PromotionOrder.create({
    ownerId,
    targetType,
    tier,
    unitAmount: config.unitAmount,
    totalAmount: config.unitAmount * ids.length,
    durationHours: config.durationHours,
    paymentReference,
    items: ids.map((targetId) => ({ targetId })),
  });
};

const promotionStatus = (item, paymentStatus, now = new Date()) => {
  if (paymentStatus !== "paid" || !item.startsAt || !item.endsAt) return paymentStatus;
  if (new Date(item.startsAt) > now) return "scheduled";
  if (new Date(item.endsAt) <= now) return "expired";
  return "active";
};

const serializePromotionOrder = (order) => {
  const value = order.toObject ? order.toObject() : order;
  const items = (value.items || []).map((item) => ({
    ...item,
    status: promotionStatus(item, value.paymentStatus),
    clickThroughRate: item.impressions ? Number(((item.clicks / item.impressions) * 100).toFixed(1)) : 0,
  }));
  return { ...value, items };
};

const applyPromotionToTarget = async ({ item, order, target }) => {
  const now = new Date();
  const currentExpiry = target.promotionExpiresAt && new Date(target.promotionExpiresAt) > now
    ? new Date(target.promotionExpiresAt)
    : now;
  let endsAt = new Date(currentExpiry.getTime() + order.durationHours * 60 * 60 * 1000);
  if (order.targetType === "event") {
    const eventEndsAt = target.endsAt || target.date;
    if (eventEndsAt && new Date(eventEndsAt) < endsAt) endsAt = new Date(eventEndsAt);
  }

  const Model = order.targetType === "listing" ? Listing : Event;
  const tags = order.targetType === "listing" ? ["top-pick"] : ["featured", "home-featured", "home-banner"];
  const update = await Model.updateOne(
    { _id: target._id, promotionReferences: { $ne: order.paymentReference } },
    {
      $addToSet: {
        promotionReferences: order.paymentReference,
        promotionTags: { $each: tags },
      },
      $set: { promotionExpiresAt: endsAt },
    },
  );

  if (!update.modifiedCount) {
    const existingItem = order.items.find((candidate) => String(candidate.targetId) === String(target._id));
    return { startsAt: existingItem?.startsAt || currentExpiry, endsAt: existingItem?.endsAt || target.promotionExpiresAt };
  }
  return { startsAt: currentExpiry, endsAt };
};

const fulfilPromotionOrder = async ({ transaction, userId }) => {
  let order = await PromotionOrder.findOne({ paymentReference: transaction.reference });
  if (!order) return null;
  if (userId && String(order.ownerId) !== String(userId)) throw httpError(403, "Promotion payment belongs to another user");
  if (transaction.status !== "success") throw httpError(400, "Promotion payment was not successful");
  if (Number(transaction.amount || 0) < order.totalAmount) throw httpError(400, "Promotion payment amount does not match the selected campaign");
  if (transaction.currency && String(transaction.currency).toUpperCase() !== order.currency) throw httpError(400, "Promotion payment currency does not match the selected campaign");
  if (order.fulfilledAt) return serializePromotionOrder(order);

  const claimed = await PromotionOrder.findOneAndUpdate(
    { _id: order._id, fulfilledAt: { $exists: false }, paymentStatus: { $in: ["pending", "failed"] } },
    { $set: { paymentStatus: "processing", paidAt: order.paidAt || new Date(transaction.paid_at || transaction.paidAt || Date.now()) } },
    { new: true },
  );
  if (!claimed) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      order = await PromotionOrder.findById(order._id);
      if (order?.fulfilledAt) return serializePromotionOrder(order);
      if (order?.paymentStatus === "failed") break;
    }
    throw httpError(409, "Promotion is still being activated. Please retry confirmation.");
  }
  order = claimed;

  let targets;
  try {
    targets = await loadEligibleTargets({
      ownerId: order.ownerId,
      targetIds: order.items.map((item) => item.targetId),
      targetType: order.targetType,
    });
    for (const target of targets) {
      const item = order.items.find((candidate) => String(candidate.targetId) === String(target._id));
      const window = await applyPromotionToTarget({ item, order, target });
      item.startsAt = window.startsAt;
      item.endsAt = window.endsAt;
      await PromotionOrder.updateOne(
        { _id: order._id, "items.targetId": target._id },
        { $set: { "items.$.startsAt": window.startsAt, "items.$.endsAt": window.endsAt } },
      );
    }
    order.paymentStatus = "paid";
    order.fulfilledAt = new Date();
    await order.save();
  } catch (error) {
    await PromotionOrder.updateOne({ _id: order._id, fulfilledAt: { $exists: false } }, { $set: { paymentStatus: "failed" } });
    throw error;
  }

  if (order.targetType === "listing") {
    await invalidatePattern("search:top-picks:*");
    await Promise.all(targets.map((target) => invalidate("listings:featured", `listing:${target._id}`, `shop:${target.shopId}:listings`)));
  } else {
    await invalidate("events:feed", "events:upcoming", "events:featured", `event:${targets[0]._id}`);
  }
  return serializePromotionOrder(order);
};

const recordListingMetric = async ({ listingId, metric, sessionId }) => {
  const now = new Date();
  const order = await PromotionOrder.findOne({
    targetType: "listing",
    paymentStatus: "paid",
    items: { $elemMatch: { targetId: listingId, startsAt: { $lte: now }, endsAt: { $gt: now } } },
  }).sort({ createdAt: -1 });
  if (!order) return { recorded: false };
  try {
    await PromotionMetricEvent.create({ promotionOrderId: order._id, targetId: listingId, metric, sessionId });
  } catch (error) {
    if (error.code === 11000) return { recorded: false };
    throw error;
  }
  const field = metric === "click" ? "items.$.clicks" : "items.$.impressions";
  await PromotionOrder.updateOne({ _id: order._id, "items.targetId": listingId }, { $inc: { [field]: 1 } });
  return { recorded: true };
};

module.exports = {
  MAX_LISTINGS_PER_ORDER,
  PROMOTION_TIERS,
  createPromotionOrder,
  fulfilPromotionOrder,
  loadEligibleTargets,
  recordListingMetric,
  serializePromotionOrder,
  tierConfig,
  uniqueIds,
};
