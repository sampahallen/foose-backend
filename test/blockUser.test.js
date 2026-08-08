const test = require("node:test");
const assert = require("node:assert/strict");
const BlockedUser = require("../src/models/BlockedUser");
const User = require("../src/models/User");
const blockController = require("../src/controllers/blockController");

const invokeController = (controller, req) => new Promise((resolve, reject) => {
  let statusCode = 200;
  const res = {
    status(value) {
      statusCode = value;
      return this;
    },
    json(payload) {
      resolve({ payload, statusCode });
      return payload;
    },
  };
  controller(req, res, (error) => reject(error || new Error("Controller called next without a response")));
});

test("blockUser rejects blocking yourself", async () => {
  await assert.rejects(
    invokeController(blockController.blockUser, {
      params: { userId: "user-1" },
      user: { id: "user-1" },
    }),
    (error) => error.statusCode === 400 && /cannot block yourself/.test(error.message),
  );
});

test("blockUser rejects a missing target user", async () => {
  const original = User.findById;
  User.findById = () => ({ select: async () => null });
  try {
    await assert.rejects(
      invokeController(blockController.blockUser, {
        params: { userId: "user-2" },
        user: { id: "user-1" },
      }),
      (error) => error.statusCode === 404,
    );
  } finally {
    User.findById = original;
  }
});

test("blockUser upserts the block relationship", async () => {
  const originals = { findById: User.findById, updateOne: BlockedUser.updateOne };
  const capture = {};
  User.findById = (id) => ({ select: async () => ({ _id: id }) });
  BlockedUser.updateOne = async (filter, update, options) => {
    Object.assign(capture, { filter, options, update });
    return { upsertedCount: 1 };
  };

  try {
    const { payload } = await invokeController(blockController.blockUser, {
      params: { userId: "user-2" },
      user: { id: "user-1" },
    });
    assert.equal(payload.data.active, true);
    assert.deepEqual(capture.filter, { userId: "user-1", blockedUserId: "user-2" });
    assert.equal(capture.options.upsert, true);
  } finally {
    User.findById = originals.findById;
    BlockedUser.updateOne = originals.updateOne;
  }
});

test("unblockUser always returns an inactive block state", async () => {
  const original = BlockedUser.findOneAndDelete;
  const capture = {};
  BlockedUser.findOneAndDelete = async (filter) => {
    capture.filter = filter;
    return null;
  };

  try {
    const { payload } = await invokeController(blockController.unblockUser, {
      params: { userId: "user-2" },
      user: { id: "user-1" },
    });
    assert.equal(payload.data.active, false);
    assert.deepEqual(capture.filter, { userId: "user-1", blockedUserId: "user-2" });
  } finally {
    BlockedUser.findOneAndDelete = original;
  }
});

test("blockStatus reflects whether a block record exists", async () => {
  const original = BlockedUser.findOne;

  BlockedUser.findOne = () => ({ select: async () => ({ _id: "block-1" }) });
  try {
    const { payload } = await invokeController(blockController.blockStatus, {
      params: { userId: "user-2" },
      user: { id: "user-1" },
    });
    assert.equal(payload.data.active, true);
  } finally {
    BlockedUser.findOne = original;
  }

  BlockedUser.findOne = () => ({ select: async () => null });
  try {
    const { payload } = await invokeController(blockController.blockStatus, {
      params: { userId: "user-2" },
      user: { id: "user-1" },
    });
    assert.equal(payload.data.active, false);
  } finally {
    BlockedUser.findOne = original;
  }
});
