const Bargain = require("../models/Bargain");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const {
  actOnBargain,
  bargainPopulate,
  openBargain,
  presentBargain,
} = require("../services/bargainService");
const { roleFor } = require("../services/bargainRules");

const pageOptions = (query, fallbackLimit = 20) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || fallbackLimit), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

exports.createBargain = asyncHandler(async (req, res) => {
  const result = await openBargain({
    amount: req.body.amount,
    listingId: req.body.listingId,
    note: req.body.note,
    userId: req.user.id,
  });
  return success(res, result, "Offer sent", 201);
});

exports.listBargains = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req.query);
  const filter = {};
  if (req.query.role === "seller") filter.sellerId = req.user.id;
  else if (req.query.role === "buyer") filter.buyerId = req.user.id;
  else filter.$or = [{ buyerId: req.user.id }, { sellerId: req.user.id }];
  if (req.query.status) filter.status = req.query.status;
  if (req.query.listingId) filter.listingId = req.query.listingId;

  const [bargains, total] = await Promise.all([
    Bargain.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(bargainPopulate),
    Bargain.countDocuments(filter),
  ]);

  return success(
    res,
    {
      bargains: bargains.map((bargain) => presentBargain(bargain, req.user.id)),
      limit,
      page,
      pages: Math.ceil(total / limit),
      total,
    },
    "Bargains loaded",
  );
});

// Powers the buyer's "your price" badge on listing detail and checkout. Only
// ever returns the caller's own bargain, so one buyer can never read another's
// negotiated price.
exports.getMyListingBargain = asyncHandler(async (req, res) => {
  const bargain = await Bargain.findOne({
    buyerId: req.user.id,
    isActive: true,
    listingId: req.params.listingId,
  }).populate(bargainPopulate);

  return success(
    res,
    { bargain: bargain ? presentBargain(bargain, req.user.id) : null },
    "Bargain loaded",
  );
});

exports.getBargain = asyncHandler(async (req, res) => {
  const bargain = await Bargain.findById(req.params.id).populate(bargainPopulate);
  if (!bargain) throw httpError(404, "Bargain not found");
  if (!roleFor(bargain, req.user.id)) throw httpError(403, "You are not part of this bargain");

  return success(res, { bargain: presentBargain(bargain, req.user.id) }, "Bargain loaded");
});

const actionHandler = (action) =>
  asyncHandler(async (req, res) => {
    const result = await actOnBargain({
      action,
      amount: req.body?.amount,
      bargainId: req.params.id,
      note: req.body?.note,
      userId: req.user.id,
    });
    return success(res, result, "Bargain updated");
  });

exports.counterBargain = actionHandler("counter");
exports.acceptBargain = actionHandler("accept");
exports.declineBargain = actionHandler("decline");
exports.cancelBargain = actionHandler("cancel");
