const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const authController = require("../src/controllers/authController");

const invokeForError = (controller, req) => new Promise((resolve, reject) => {
  controller(req, {}, (error) => {
    if (error) resolve(error);
    else reject(new Error("Controller continued without reporting an error"));
  });
});

test("password reset requests reject email addresses that are not in the user records", async () => {
  const originalFindOne = User.findOne;
  let receivedFilter;
  User.findOne = (filter) => {
    receivedFilter = filter;
    return { select: async () => null };
  };

  try {
    const error = await invokeForError(authController.forgotPassword, {
      body: { email: "missing@example.com" },
    });

    assert.deepEqual(receivedFilter, {
      accountStatus: { $ne: "deleted" },
      email: "missing@example.com",
    });
    assert.equal(error.statusCode, 404);
    assert.equal(error.message, "No Foose account was found with that email address");
  } finally {
    User.findOne = originalFindOne;
  }
});
