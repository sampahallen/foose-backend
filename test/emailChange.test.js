const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const userController = require("../src/controllers/userController");
const {
  consumeEmailChangeToken,
  emailChangeConfirmationLink,
  hashEmailChangeToken,
} = require("../src/services/emailChangeService");

const token = "a".repeat(64);

const invokeForError = (controller, req) => new Promise((resolve, reject) => {
  controller(req, {}, (error) => {
    if (error) resolve(error);
    else reject(new Error("Controller continued without reporting an error"));
  });
});

test("email change confirmation links use only the configured frontend host and base path", () => {
  const originalClientUrl = process.env.CLIENT_URL;
  const originalClientBasePath = process.env.CLIENT_BASE_PATH;
  process.env.CLIENT_URL = "https://foose.example/";
  process.env.CLIENT_BASE_PATH = "/marketplace/";

  try {
    const link = emailChangeConfirmationLink(token);
    assert.equal(link, `https://foose.example/marketplace/#/confirm-email-change/${token}`);
  } finally {
    if (originalClientUrl === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = originalClientUrl;
    if (originalClientBasePath === undefined) delete process.env.CLIENT_BASE_PATH;
    else process.env.CLIENT_BASE_PATH = originalClientBasePath;
  }
});

test("email change consumption uses the hashed token, an unexpired pipeline update, and unsets pending fields", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  let received;
  const updatedUser = { _id: "user-1", email: "new@example.com" };
  User.findOneAndUpdate = (filter, update, options) => {
    received = { filter, options, update };
    return updatedUser;
  };

  try {
    assert.equal(await consumeEmailChangeToken(token), updatedUser);
    assert.equal(received.filter.pendingEmailToken, hashEmailChangeToken(token));
    assert.ok(received.filter.pendingEmailExpires.$gt instanceof Date);
    assert.deepEqual(received.options, { new: true });
    assert.deepEqual(received.update[0], { $set: { email: "$pendingEmail", isEmailVerified: true } });
    assert.deepEqual(received.update[1], { $unset: ["pendingEmail", "pendingEmailToken", "pendingEmailExpires"] });
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("expired or already-consumed email change tokens return no user", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  User.findOneAndUpdate = () => null;
  try {
    assert.equal(await consumeEmailChangeToken(token), null);
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("a duplicate email claimed between request and confirmation surfaces as EMAIL_TAKEN", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  User.findOneAndUpdate = () => {
    const error = new Error("duplicate key");
    error.code = 11000;
    throw error;
  };

  try {
    await assert.rejects(
      consumeEmailChangeToken(token),
      (error) => error.code === "EMAIL_TAKEN",
    );
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("requesting an email change with the wrong current password is rejected with 400", async () => {
  const originalFindById = User.findById;
  User.findById = () => ({
    select: async () => ({ passwordHash: await require("bcrypt").hash("correct-password", 4) }),
  });

  try {
    const error = await invokeForError(userController.requestEmailChange, {
      body: { currentPassword: "wrong-password", newEmail: "new@example.com" },
      user: { id: "user-1" },
    });
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, "Current password is incorrect");
  } finally {
    User.findById = originalFindById;
  }
});

test("requesting an email change to an address already in use is rejected with 409", async () => {
  const originalFindById = User.findById;
  const originalExists = User.exists;
  const correctPassword = "correct-password";
  const passwordHash = await require("bcrypt").hash(correctPassword, 4);
  User.findById = () => ({ select: async () => ({ passwordHash }) });
  User.exists = async () => true;

  try {
    const error = await invokeForError(userController.requestEmailChange, {
      body: { currentPassword: correctPassword, newEmail: "taken@example.com" },
      user: { id: "user-1" },
    });
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, "That email address is already in use");
  } finally {
    User.findById = originalFindById;
    User.exists = originalExists;
  }
});

test("confirming with an invalid or expired token is rejected with 400", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  User.findOneAndUpdate = () => null;

  try {
    const error = await invokeForError(userController.confirmEmailChange, {
      body: { token },
    });
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, "Invalid or expired email change link");
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
