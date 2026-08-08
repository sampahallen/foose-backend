const USER_REPORT_REASONS = Object.freeze([
  "harassment",
  "scam_or_fraud",
  "counterfeit_or_fake_listings",
  "inappropriate_content",
  "spam",
  "other",
]);

const USER_REPORT_STATUSES = Object.freeze(["open", "resolved", "dismissed"]);

module.exports = {
  USER_REPORT_REASONS,
  USER_REPORT_STATUSES,
};
