const SiteAnalyticsEvent = require("../models/SiteAnalyticsEvent");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");

exports.recordEvent = asyncHandler(async (req, res) => {
  await SiteAnalyticsEvent.create({
    ...req.body,
    userAgent: req.get("user-agent") || req.body.userAgent || "",
  });

  return success(res, {}, "Analytics event recorded", 201);
});
