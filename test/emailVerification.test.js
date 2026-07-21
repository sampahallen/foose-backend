const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const authController = require("../src/controllers/authController");
const authRoutes = require("../src/routes/authRoutes");
const {
  consumeEmailVerificationToken,
  emailVerificationLink,
  hashEmailVerificationToken,
} = require("../src/services/emailVerificationService");

const token = "a".repeat(64);

const invokeController = (controller, req) => new Promise((resolve, reject) => {
  const res = {
    status() { return this; },
    json(payload) { resolve(payload); return payload; },
  };
  controller(req, res, (error) => reject(error || new Error("Controller called next without a response")));
});

test("verification links use only the configured frontend host and base path", () => {
  const originalClientUrl = process.env.CLIENT_URL;
  const originalClientBasePath = process.env.CLIENT_BASE_PATH;
  const originalApiUrl = process.env.API_PUBLIC_URL;
  process.env.CLIENT_URL = "https://foose.example/";
  process.env.CLIENT_BASE_PATH = "/marketplace/";
  process.env.API_PUBLIC_URL = "https://raw-backend.example";

  try {
    const link = emailVerificationLink(token);
    assert.equal(link, `https://foose.example/marketplace/#/verify-email/${token}`);
    assert.equal(link.includes("raw-backend.example"), false);
  } finally {
    if (originalClientUrl === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = originalClientUrl;
    if (originalClientBasePath === undefined) delete process.env.CLIENT_BASE_PATH;
    else process.env.CLIENT_BASE_PATH = originalClientBasePath;
    if (originalApiUrl === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = originalApiUrl;
  }
});

test("verification consumption uses the hashed token and an unexpired atomic update", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  let received;
  const verifiedUser = { _id: "user-1", email: "buyer@example.com" };
  User.findOneAndUpdate = (filter, update, options) => {
    received = { filter, options, update };
    return { select: async () => verifiedUser };
  };

  try {
    assert.equal(await consumeEmailVerificationToken(token), verifiedUser);
    assert.equal(received.filter.emailVerifyToken, hashEmailVerificationToken(token));
    assert.ok(received.filter.emailVerifyExpires.$gt instanceof Date);
    assert.deepEqual(received.options, { new: true });
    assert.equal(received.update.$set.isEmailVerified, true);
    assert.equal(received.update.$unset.emailVerifyToken, "");
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("expired or already-consumed verification tokens return no user", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  User.findOneAndUpdate = () => ({ select: async () => null });
  try {
    assert.equal(await consumeEmailVerificationToken(token), null);
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("only one concurrent verification attempt can consume a token", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  let calls = 0;
  User.findOneAndUpdate = () => ({
    select: async () => {
      calls += 1;
      return calls === 1 ? { _id: "user-1" } : null;
    },
  });

  try {
    const results = await Promise.all([
      consumeEmailVerificationToken(token),
      consumeEmailVerificationToken(token),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("the frontend verification endpoint rejects malformed tokens with 400", async () => {
  await assert.rejects(
    invokeController(authController.verifyEmailFromClient, { body: { token: "not-a-token" } }),
    (error) => error.statusCode === 400 && error.message === "Invalid email verification token",
  );
});

test("the POST verification route is registered alongside the legacy GET route", () => {
  const verificationRoutes = authRoutes.stack
    .filter((layer) => layer.route?.path === "/verify-email" || layer.route?.path === "/verify-email/:token")
    .map((layer) => ({ methods: layer.route.methods, path: layer.route.path }));

  assert.equal(verificationRoutes.some(({ methods, path }) => path === "/verify-email" && methods.post), true);
  assert.equal(verificationRoutes.some(({ methods, path }) => path === "/verify-email/:token" && methods.get), true);
});
