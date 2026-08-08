const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { createUserReport } = require("../services/userReportService");

exports.createReport = asyncHandler(async (req, res) => {
  const details = (req.body.details || "").trim();
  if (req.body.reason === "other" && !details) {
    throw httpError(422, "Please describe the issue when choosing 'Other'");
  }

  const report = await createUserReport({
    reporterId: req.user.id,
    reportedUserId: req.body.reportedUserId,
    reason: req.body.reason,
    details,
  });

  return success(res, { report }, "Report submitted");
});
