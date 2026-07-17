const { RECOMMENDATION_SIGNALS } = require("../constants/recommendations");
const {
  awardFinspoSignal,
  awardListingSignal,
  buildFinspoFeed,
  buildRecommendationFeed,
  buildSuggestedFeed,
} = require("../services/recommendationService");
const { buildExploreFeed } = require("../services/exploreRecommendationService");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");

exports.getFeed = asyncHandler(async (req, res) => {
  const data = await buildRecommendationFeed({
    query: req.query,
    userId: req.user?.id,
  });

  return success(res, data, "Recommendation feed loaded");
});

exports.getFinspoFeed = asyncHandler(async (req, res) => {
  const data = await buildFinspoFeed({
    query: req.query,
    userId: req.user?.id,
  });

  return success(res, data, "Finspo recommendation feed loaded");
});

exports.getSuggestedFeed = asyncHandler(async (req, res) => {
  const data = await buildSuggestedFeed({
    query: req.query,
    userId: req.user.id,
  });

  return success(res, data, "Suggested feed loaded");
});

exports.getExploreFeed = asyncHandler(async (req, res) => {
  const data = await buildExploreFeed({
    query: req.validated?.query || req.query,
    userId: req.user?.id,
  });

  return success(res, data, "Explore feed loaded");
});

exports.recordListingSignal = asyncHandler(async (req, res) => {
  const signal = req.body.type;
  const profile = await awardListingSignal(
    req.user.id,
    req.body.listingId,
    signal,
    { dwellMs: req.body.dwellMs },
  );

  return success(
    res,
    {
      recorded: Boolean(profile),
      type: signal,
    },
    signal === RECOMMENDATION_SIGNALS.DWELL ? "Dwell signal recorded" : "Recommendation signal recorded",
  );
});

exports.recordFinspoSignal = asyncHandler(async (req, res) => {
  const signal = req.body.type;
  const profile = await awardFinspoSignal(
    req.user.id,
    req.body.postId,
    signal,
  );

  return success(
    res,
    {
      recorded: Boolean(profile),
      type: signal,
    },
    "Finspo recommendation signal recorded",
  );
});
