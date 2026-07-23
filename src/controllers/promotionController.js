const Event = require("../models/Event");
const Listing = require("../models/Listing");
const PromotionOrder = require("../models/PromotionOrder");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");
const { recordListingMetric, serializePromotionOrder } = require("../services/promotionService");

exports.listMine = asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id };
  if (req.query.targetType) filter.targetType = req.query.targetType;
  const orders = await PromotionOrder.find(filter).sort({ createdAt: -1 }).limit(100);
  const listingIds = orders.filter((order) => order.targetType === "listing").flatMap((order) => order.items.map((item) => item.targetId));
  const eventIds = orders.filter((order) => order.targetType === "event").flatMap((order) => order.items.map((item) => item.targetId));
  const [listings, events] = await Promise.all([
    Listing.find({ _id: { $in: listingIds } }).select("title images").lean(),
    Event.find({ _id: { $in: eventIds } }).select("title coverImage date").lean(),
  ]);
  const targets = new Map([...listings, ...events].map((target) => [String(target._id), target]));
  const promotions = orders.map((order) => {
    const serialized = serializePromotionOrder(order);
    serialized.items = serialized.items.map((item) => ({ ...item, target: targets.get(String(item.targetId)) || null }));
    return serialized;
  });
  return success(res, { promotions }, "Promotions loaded");
});

exports.recordListingMetric = asyncHandler(async (req, res) => {
  const result = await recordListingMetric({ listingId: req.params.listingId, metric: req.body.metric, sessionId: req.body.sessionId });
  return success(res, result, result.recorded ? "Promotion metric recorded" : "Promotion metric already recorded");
});
