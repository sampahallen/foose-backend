const User = require("../models/User");
const UserReport = require("../models/UserReport");
const httpError = require("../utils/httpError");

const reportPopulate = [
  { path: "reporterId", select: "name email username phone profilePhoto" },
  { path: "reportedUserId", select: "name email username phone profilePhoto" },
];

const createUserReport = async ({ reporterId, reportedUserId, reason, details }) => {
  const reportedUser = await User.findById(reportedUserId).select("_id");
  if (!reportedUser) throw httpError(404, "User not found");

  try {
    const report = await UserReport.create({
      reporterId,
      reportedUserId,
      reason,
      details,
    });
    return report.populate(reportPopulate);
  } catch (err) {
    if (err?.code === 11000) {
      throw httpError(409, "You already have an open report against this account");
    }
    throw err;
  }
};

const resolveUserReport = async ({ reportId, resolverId, outcome, note }) => {
  const report = await UserReport.findOne({ _id: reportId, isActive: true });
  if (!report) throw httpError(404, "Active user report not found");

  report.status = outcome;
  report.isActive = false;
  report.resolution = {
    resolverId,
    note: note || "",
    resolvedAt: new Date(),
  };
  await report.save();

  return report.populate(reportPopulate);
};

module.exports = {
  createUserReport,
  resolveUserReport,
};
