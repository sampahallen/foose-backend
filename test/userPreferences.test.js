const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const User = require("../src/models/User");
const userController = require("../src/controllers/userController");
const { categoryEmailEnabled, createNotification } = require("../src/services/notificationService");
const Notification = require("../src/models/Notification");

const invokeController = (controller, req) => new Promise((resolve, reject) => {
  const res = {
    status() { return this; },
    json(payload) { resolve(payload); return payload; },
  };
  controller(req, res, (error) => reject(error || new Error("Controller called next without a response")));
});

const leanQuery = (value) => ({
  lean: async () => value,
  select() {
    return this;
  },
});

test("updating preferences only $sets the leaf keys present in the request, never the whole subdocument", async () => {
  const originalFindByIdAndUpdate = User.findByIdAndUpdate;
  let received;
  const updatedUser = { _id: "user-1", preferences: { theme: "dark" } };
  User.findByIdAndUpdate = (id, update, options) => {
    received = { id, options, update };
    return { select: async () => updatedUser };
  };

  try {
    await invokeController(userController.updatePreferences, {
      body: { theme: "dark", notifications: { order: { email: false } } },
      user: { id: "user-1" },
    });

    assert.equal(received.id, "user-1");
    assert.deepEqual(received.options, { new: true, runValidators: true });
    assert.deepEqual(received.update, {
      $set: {
        "preferences.theme": "dark",
        "preferences.notifications.order.email": false,
      },
    });
  } finally {
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test("a theme-only update does not touch any notification keys", async () => {
  const originalFindByIdAndUpdate = User.findByIdAndUpdate;
  let received;
  User.findByIdAndUpdate = (id, update) => {
    received = update;
    return { select: async () => ({ _id: "user-1" }) };
  };

  try {
    await invokeController(userController.updatePreferences, {
      body: { theme: "light" },
      user: { id: "user-1" },
    });
    assert.deepEqual(received, { $set: { "preferences.theme": "light" } });
  } finally {
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test("the system category can update email and inApp independently", async () => {
  const originalFindByIdAndUpdate = User.findByIdAndUpdate;
  let received;
  User.findByIdAndUpdate = (id, update) => {
    received = update;
    return { select: async () => ({ _id: "user-1" }) };
  };

  try {
    await invokeController(userController.updatePreferences, {
      body: { notifications: { system: { inApp: false } } },
      user: { id: "user-1" },
    });
    assert.deepEqual(received, { $set: { "preferences.notifications.system.inApp": false } });
  } finally {
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test("categoryEmailEnabled defaults to true for accounts that predate the preferences field", async () => {
  const originalFindById = User.findById;
  User.findById = () => leanQuery(null);
  try {
    assert.equal(await categoryEmailEnabled("user-1", "order"), true);
  } finally {
    User.findById = originalFindById;
  }
});

test("categoryEmailEnabled respects an explicit false", async () => {
  const originalFindById = User.findById;
  User.findById = () => leanQuery({ preferences: { notifications: { order: { email: false } } } });
  try {
    assert.equal(await categoryEmailEnabled("user-1", "order"), false);
  } finally {
    User.findById = originalFindById;
  }
});

test("a disabled order email preference stops createNotification from flagging lifecycleEmailRequired", async () => {
  const originalCreate = Notification.create;
  const originalFindById = User.findById;
  let createdPayload;
  Notification.create = async (payload) => {
    createdPayload = payload;
    return { _id: new mongoose.Types.ObjectId(), ...payload };
  };
  User.findById = () => leanQuery({ preferences: { notifications: { order: { email: false } } } });

  try {
    await createNotification({
      body: "Order body",
      lifecycleEmailRequired: true,
      title: "Order title",
      type: "order",
      userId: "user-1",
    });
    assert.equal("lifecycleEmailRequired" in createdPayload, false);
  } finally {
    Notification.create = originalCreate;
    User.findById = originalFindById;
  }
});

test("an enabled order email preference still flags lifecycleEmailRequired", async () => {
  const originalCreate = Notification.create;
  const originalFindById = User.findById;
  let createdPayload;
  Notification.create = async (payload) => {
    createdPayload = payload;
    return { _id: new mongoose.Types.ObjectId(), ...payload };
  };
  User.findById = () => leanQuery(null);

  try {
    await createNotification({
      body: "Order body",
      lifecycleEmailRequired: true,
      title: "Order title",
      type: "order",
      userId: "user-1",
    });
    assert.equal(createdPayload.lifecycleEmailRequired, true);
  } finally {
    Notification.create = originalCreate;
    User.findById = originalFindById;
  }
});

test("a muted system inApp preference stops the notification from being created at all", async () => {
  const originalCreate = Notification.create;
  const originalFindById = User.findById;
  let createCalled = false;
  Notification.create = async (payload) => {
    createCalled = true;
    return { _id: new mongoose.Types.ObjectId(), ...payload };
  };
  User.findById = () => leanQuery({ preferences: { notifications: { system: { inApp: false } } } });

  try {
    const result = await createNotification({
      body: "New follower",
      title: "New follower",
      type: "system",
      userId: "user-1",
    });
    assert.equal(result, null);
    assert.equal(createCalled, false);
  } finally {
    Notification.create = originalCreate;
    User.findById = originalFindById;
  }
});

test("kyc notifications bypass preference gating even if lifecycleEmailRequired is somehow passed", async () => {
  const originalCreate = Notification.create;
  const originalFindById = User.findById;
  let createdPayload;
  let findByIdCalled = false;
  Notification.create = async (payload) => {
    createdPayload = payload;
    return { _id: new mongoose.Types.ObjectId(), ...payload };
  };
  User.findById = () => {
    findByIdCalled = true;
    return leanQuery({ preferences: { notifications: {} } });
  };

  try {
    await createNotification({
      body: "KYC approved",
      lifecycleEmailRequired: true,
      title: "KYC approved",
      type: "kyc",
      userId: "user-1",
    });
    assert.equal("lifecycleEmailRequired" in createdPayload, false, "kyc never uses the lifecycle-email flag");
    assert.equal(findByIdCalled, false, "kyc never consults stored preferences");
  } finally {
    Notification.create = originalCreate;
    User.findById = originalFindById;
  }
});
