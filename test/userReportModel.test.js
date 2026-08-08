const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const UserReport = require("../src/models/UserReport");

const objectId = () => new mongoose.Types.ObjectId();

test("UserReport rejects reporting yourself", async () => {
  const userId = objectId();
  const report = new UserReport({
    reason: "spam",
    reportedUserId: userId,
    reporterId: userId,
  });

  await assert.rejects(report.validate(), /cannot report yourself/);
});

test("UserReport requires details when reason is 'other'", () => {
  const missingDetails = new UserReport({
    reason: "other",
    reportedUserId: objectId(),
    reporterId: objectId(),
  });
  assert.match(
    missingDetails.validateSync().errors.details.message,
    /Details are required/,
  );

  const withDetails = new UserReport({
    details: "This seller sent me counterfeit items.",
    reason: "other",
    reportedUserId: objectId(),
    reporterId: objectId(),
  });
  assert.equal(withDetails.validateSync(), undefined);
});

test("UserReport does not require details for non-'other' reasons", () => {
  const report = new UserReport({
    reason: "harassment",
    reportedUserId: objectId(),
    reporterId: objectId(),
  });
  assert.equal(report.validateSync(), undefined);
});

test("UserReport rejects an unknown reason", () => {
  const report = new UserReport({
    reason: "not_a_real_reason",
    reportedUserId: objectId(),
    reporterId: objectId(),
  });
  assert.match(report.validateSync().errors.reason.message, /not_a_real_reason/);
});
