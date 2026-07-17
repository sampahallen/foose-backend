const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const userController = require("../src/controllers/userController");
const userRoutes = require("../src/routes/userRoutes");

const invokeController = (controller, req) => new Promise((resolve, reject) => {
  let statusCode = 200;
  const res = {
    status(nextStatusCode) {
      statusCode = nextStatusCode;
      return this;
    },
    json(payload) {
      resolve({ payload, statusCode });
      return payload;
    },
  };

  controller(req, res, (error) => reject(error || new Error("Controller called next without a response")));
});

test("username availability validation normalizes valid usernames and rejects invalid values", () => {
  const schema = userRoutes.usernameAvailabilityQuerySchema;
  const normalized = schema.safeParse({ username: "  New.User_1  " });

  assert.equal(normalized.success, true);
  assert.equal(normalized.data.username, "new.user_1");
  assert.equal(schema.safeParse({ username: "ab" }).success, false);
  assert.equal(schema.safeParse({ username: "contains-space" }).success, false);
  assert.equal(schema.safeParse({ username: "a".repeat(21) }).success, false);
  assert.equal(schema.safeParse({ username: "valid_name", extra: "value" }).success, false);
});

test("the signed-in user's current username remains available", async () => {
  const originalExists = User.exists;
  let receivedFilter;
  User.exists = async (filter) => {
    receivedFilter = filter;
    return null;
  };

  try {
    const { payload, statusCode } = await invokeController(userController.usernameAvailability, {
      query: { username: "CURRENT_USER" },
      user: { id: "current-user-id" },
      validated: { query: { username: "current_user" } },
    });

    assert.equal(statusCode, 200);
    assert.deepEqual(receivedFilter, {
      username: "current_user",
      _id: { $ne: "current-user-id" },
    });
    assert.deepEqual(payload, {
      success: true,
      data: { username: "current_user", available: true },
      message: "Username availability checked",
    });
  } finally {
    User.exists = originalExists;
  }
});

test("a username owned by another user is unavailable", async () => {
  const originalExists = User.exists;
  User.exists = async () => ({ _id: "another-user-id" });

  try {
    const { payload } = await invokeController(userController.usernameAvailability, {
      query: { username: "TAKEN.NAME" },
      user: { id: "current-user-id" },
      validated: { query: { username: "taken.name" } },
    });

    assert.deepEqual(payload.data, {
      username: "taken.name",
      available: false,
    });
  } finally {
    User.exists = originalExists;
  }
});

test("username availability route is registered before public username routes", () => {
  const routePaths = userRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);
  const availabilityIndex = routePaths.indexOf("/username-availability");

  assert.notEqual(availabilityIndex, -1);
  assert.ok(availabilityIndex < routePaths.indexOf("/:username/profile"));
  assert.ok(availabilityIndex < routePaths.indexOf("/:username"));
});
