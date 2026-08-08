const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const UserReport = require("../src/models/UserReport");
const { createUserReport, resolveUserReport } = require("../src/services/userReportService");

test("createUserReport rejects a reportedUserId that does not exist", async () => {
  const original = User.findById;
  User.findById = () => ({ select: async () => null });

  try {
    await assert.rejects(
      createUserReport({ reason: "spam", reportedUserId: "missing-user", reporterId: "user-1" }),
      (error) => error.statusCode === 404,
    );
  } finally {
    User.findById = original;
  }
});

test("createUserReport creates and returns a populated report", async () => {
  const originals = { create: UserReport.create, findById: User.findById };
  const capture = {};
  User.findById = () => ({ select: async () => ({ _id: "user-2" }) });
  UserReport.create = async (data) => {
    capture.data = data;
    return {
      ...data,
      _id: "report-1",
      populate: async () => ({ ...data, _id: "report-1" }),
    };
  };

  try {
    const report = await createUserReport({
      details: "",
      reason: "spam",
      reportedUserId: "user-2",
      reporterId: "user-1",
    });
    assert.equal(report._id, "report-1");
    assert.equal(capture.data.reporterId, "user-1");
    assert.equal(capture.data.reportedUserId, "user-2");
  } finally {
    User.findById = originals.findById;
    UserReport.create = originals.create;
  }
});

test("createUserReport maps a duplicate open report to a 409 error", async () => {
  const originals = { create: UserReport.create, findById: User.findById };
  User.findById = () => ({ select: async () => ({ _id: "user-2" }) });
  UserReport.create = async () => {
    const duplicateError = new Error("duplicate key");
    duplicateError.code = 11000;
    throw duplicateError;
  };

  try {
    await assert.rejects(
      createUserReport({ reason: "spam", reportedUserId: "user-2", reporterId: "user-1" }),
      (error) => error.statusCode === 409 && /already have an open report/.test(error.message),
    );
  } finally {
    User.findById = originals.findById;
    UserReport.create = originals.create;
  }
});

test("resolveUserReport rejects when there is no active report", async () => {
  const original = UserReport.findOne;
  UserReport.findOne = async () => null;

  try {
    await assert.rejects(
      resolveUserReport({ outcome: "resolved", reportId: "missing", resolverId: "admin-1" }),
      (error) => error.statusCode === 404,
    );
  } finally {
    UserReport.findOne = original;
  }
});

test("resolveUserReport closes the report with the resolution details", async () => {
  const original = UserReport.findOne;
  const report = {
    isActive: true,
    populate: async function populate() { return this; },
    save: async function save() { return this; },
    status: "open",
  };
  UserReport.findOne = async () => report;

  try {
    const resolved = await resolveUserReport({
      note: "Warned the seller",
      outcome: "dismissed",
      reportId: "report-1",
      resolverId: "admin-1",
    });
    assert.equal(resolved.status, "dismissed");
    assert.equal(resolved.isActive, false);
    assert.equal(resolved.resolution.resolverId, "admin-1");
    assert.equal(resolved.resolution.note, "Warned the seller");
    assert.ok(resolved.resolution.resolvedAt instanceof Date);
  } finally {
    UserReport.findOne = original;
  }
});
