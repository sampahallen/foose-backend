const Favorite = require("../models/Favorite");
const Event = require("../models/Event");
const GalleryPost = require("../models/GalleryPost");
const Listing = require("../models/Listing");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { RECOMMENDATION_SIGNALS } = require("../constants/recommendations");
const { awardListingSignal } = require("../services/recommendationService");

const targetModels = {
  event: Event,
  listing: Listing,
};

const savedIds = (favorites, targetType) =>
  favorites
    .filter((favorite) => favorite.targetType === targetType)
    .map((favorite) => favorite.targetId.toString());

const ensureTarget = async (targetType, targetId) => {
  const Model = targetModels[targetType];
  if (!Model) throw httpError(400, "Unsupported favorite target");

  const filter =
    targetType === "listing"
      ? { _id: targetId, status: { $ne: "removed" } }
      : { _id: targetId };

  const target = await Model.findOne(filter).select("_id");
  if (!target) throw httpError(404, "Favorite target not found");
};

exports.listFavorites = asyncHandler(async (req, res) => {
  const favorites = await Favorite.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
  const listingIds = savedIds(favorites, "listing");
  const eventIds = savedIds(favorites, "event");

  const [listings, events, finspos] = await Promise.all([
    Listing.find({ _id: { $in: listingIds }, status: { $ne: "removed" } })
      .populate("shopId", "shopName slug rating totalReviews")
      .lean(),
    Event.find({ _id: { $in: eventIds } }).sort({ date: -1, createdAt: -1 }).lean(),
    GalleryPost.find({ likes: req.user.id })
      .populate("userId", "name username profilePhoto isKycVerified")
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const listingOrder = new Map(listingIds.map((id, index) => [id, index]));
  const eventOrder = new Map(eventIds.map((id, index) => [id, index]));

  return success(
    res,
    {
      ids: {
        events: eventIds,
        finspos: finspos.map((post) => post._id.toString()),
        listings: listingIds,
      },
      events: events.sort((a, b) => (eventOrder.get(a._id.toString()) ?? 0) - (eventOrder.get(b._id.toString()) ?? 0)),
      finspos,
      listings: listings.sort((a, b) => (listingOrder.get(a._id.toString()) ?? 0) - (listingOrder.get(b._id.toString()) ?? 0)),
    },
    "Favorites loaded",
  );
});

exports.favoriteStatus = asyncHandler(async (req, res) => {
  const { targetType, targetId } = req.query;

  if (!targetType || !targetId) {
    throw httpError(400, "targetType and targetId are required");
  }

  if (!targetModels[targetType]) throw httpError(400, "Unsupported favorite target");

  const favorite = await Favorite.findOne({
    userId: req.user.id,
    targetType,
    targetId,
  }).select("_id");

  return success(res, { active: Boolean(favorite) }, "Favorite status loaded");
});

exports.addFavorite = asyncHandler(async (req, res) => {
  await ensureTarget(req.params.targetType, req.params.targetId);

  const writeResult = await Favorite.updateOne(
    {
      userId: req.user.id,
      targetType: req.params.targetType,
      targetId: req.params.targetId,
    },
    {
      $setOnInsert: {
        userId: req.user.id,
        targetType: req.params.targetType,
        targetId: req.params.targetId,
      },
    },
    { setDefaultsOnInsert: true, upsert: true },
  );
  const favorite = await Favorite.findOne({
    userId: req.user.id,
    targetType: req.params.targetType,
    targetId: req.params.targetId,
  }).lean();

  if (req.params.targetType === "listing" && writeResult.upsertedCount > 0) {
    await awardListingSignal(
      req.user.id,
      req.params.targetId,
      RECOMMENDATION_SIGNALS.FAVORITE,
    ).catch((error) => {
      console.warn(`Favorite recommendation signal failed: ${error.message}`);
    });
  }

  return success(res, { favorite, active: true }, "Saved");
});

exports.removeFavorite = asyncHandler(async (req, res) => {
  if (!targetModels[req.params.targetType]) throw httpError(400, "Unsupported favorite target");

  await Favorite.findOneAndDelete({
    userId: req.user.id,
    targetType: req.params.targetType,
    targetId: req.params.targetId,
  });

  return success(res, { active: false }, "Removed");
});
