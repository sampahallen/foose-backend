const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const userController = require("../src/controllers/userController");
const userRoutes = require("../src/routes/userRoutes");

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

const query = (value, capture = {}) => ({
  lean: async () => value,
  limit(limit) {
    capture.limit = limit;
    return this;
  },
  select(select) {
    capture.select = select;
    return this;
  },
  skip(skip) {
    capture.skip = skip;
    return this;
  },
  sort(sort) {
    capture.sort = sort;
    return this;
  },
});

test("connection query validation supports only bounded follower list requests", () => {
  const schema = userRoutes.profileConnectionsQuerySchema;
  assert.deepEqual(schema.parse({ type: "followers" }), { type: "followers", page: 1, limit: 30 });
  assert.deepEqual(schema.parse({ type: "following", page: "2", limit: "15" }), { type: "following", page: 2, limit: 15 });
  assert.equal(schema.safeParse({ type: "friends" }).success, false);
  assert.equal(schema.safeParse({ type: "followers", page: 0 }).success, false);
  assert.equal(schema.safeParse({ type: "following", limit: 31 }).success, false);
});

test("profile owners can paginate all connections in stable username order", async () => {
  const originals = { count: User.countDocuments, find: User.find, findOne: User.findOne };
  const capture = {};
  const target = { _id: { toString: () => "owner-1" }, following: ["member-1"], username: "ama" };
  const items = [{ _id: "member-1", name: "Abena", username: "abena" }];
  User.findOne = () => query(target);
  User.countDocuments = async () => 65;
  User.find = (filter) => {
    capture.filter = filter;
    return query(items, capture);
  };

  try {
    const { payload } = await invokeController(userController.getProfileConnections, {
      params: { username: "ama" },
      query: {},
      user: { id: "owner-1" },
      validated: { params: { username: "ama" }, query: { limit: 30, page: 2, type: "following" } },
    });
    assert.deepEqual(payload.data.items, items);
    assert.equal(payload.data.page, 2);
    assert.equal(payload.data.pages, 3);
    assert.equal(payload.data.restricted, false);
    assert.equal(capture.skip, 30);
    assert.equal(capture.limit, 30);
    assert.deepEqual(capture.sort, { username: 1, _id: 1 });
    assert.deepEqual(capture.filter._id.$in, target.following);
    assert.ok(capture.filter.$or);
  } finally {
    User.countDocuments = originals.count;
    User.find = originals.find;
    User.findOne = originals.findOne;
  }
});

test("non-owners receive at most the first 30 connections and a restriction marker", async () => {
  const originals = { count: User.countDocuments, find: User.find, findOne: User.findOne };
  const capture = {};
  User.findOne = () => query({ _id: { toString: () => "owner-1" }, following: [], username: "ama" });
  User.countDocuments = async () => 42;
  User.find = (filter) => {
    capture.filter = filter;
    return query([], capture);
  };

  try {
    const { payload } = await invokeController(userController.getProfileConnections, {
      params: { username: "ama" },
      query: {},
      validated: { params: { username: "ama" }, query: { limit: 5, page: 1, type: "followers" } },
    });
    assert.equal(payload.data.pages, 1);
    assert.equal(payload.data.restricted, true);
    assert.equal(payload.data.total, 42);
    assert.equal(capture.limit, 30);
    assert.equal(capture.skip, 0);
    assert.equal(capture.filter.following.toString(), "owner-1");
    assert.ok(capture.filter.$or);
  } finally {
    User.countDocuments = originals.count;
    User.find = originals.find;
    User.findOne = originals.findOne;
  }
});

test("non-owners cannot enumerate connection pages after the first", async () => {
  const originalFindOne = User.findOne;
  User.findOne = () => query({ _id: { toString: () => "owner-1" }, following: [], username: "ama" });
  try {
    await assert.rejects(
      invokeController(userController.getProfileConnections, {
        params: { username: "ama" },
        query: {},
        user: { id: "viewer-1" },
        validated: { params: { username: "ama" }, query: { limit: 30, page: 2, type: "followers" } },
      }),
      (error) => error.statusCode === 403 && /Only @ama/.test(error.message),
    );
  } finally {
    User.findOne = originalFindOne;
  }
});

test("empty public connection lists are complete rather than restricted", async () => {
  const originals = { count: User.countDocuments, find: User.find, findOne: User.findOne };
  User.findOne = () => query({ _id: { toString: () => "owner-1" }, following: [], username: "ama" });
  User.countDocuments = async () => 0;
  User.find = () => query([]);
  try {
    const { payload } = await invokeController(userController.getProfileConnections, {
      params: { username: "ama" },
      query: {},
      validated: { params: { username: "ama" }, query: { limit: 30, page: 1, type: "followers" } },
    });
    assert.deepEqual(payload.data.items, []);
    assert.equal(payload.data.pages, 1);
    assert.equal(payload.data.restricted, false);
  } finally {
    User.countDocuments = originals.count;
    User.find = originals.find;
    User.findOne = originals.findOne;
  }
});

test("unfollow is idempotent and returns the owner's active following count", async () => {
  const originals = { count: User.countDocuments, findByIdAndUpdate: User.findByIdAndUpdate, findOne: User.findOne };
  const capture = {};
  User.findOne = () => query({ _id: { toString: () => "target-1" } });
  User.findByIdAndUpdate = (id, update, options) => {
    Object.assign(capture, { id, options, update });
    return query({ following: ["remaining-1"] });
  };
  User.countDocuments = async (filter) => {
    capture.countFilter = filter;
    return 1;
  };
  try {
    const { payload } = await invokeController(userController.unfollowUser, {
      params: { username: "kojo" },
      user: { id: "owner-1" },
      validated: { params: { username: "kojo" } },
    });
    assert.deepEqual(capture.update, { $pull: { following: capture.update.$pull.following } });
    assert.equal(capture.update.$pull.following.toString(), "target-1");
    assert.equal(payload.data.following, false);
    assert.equal(payload.data.followingCount, 1);
    assert.ok(capture.countFilter.$or);
  } finally {
    User.countDocuments = originals.count;
    User.findByIdAndUpdate = originals.findByIdAndUpdate;
    User.findOne = originals.findOne;
  }
});

test("removing a follower is idempotent and returns the remaining active count", async () => {
  const originals = { count: User.countDocuments, findOne: User.findOne, findOneAndUpdate: User.findOneAndUpdate };
  const capture = {};
  User.findOne = () => query({ _id: { toString: () => "follower-1" } });
  User.findOneAndUpdate = (filter, update) => {
    capture.filter = filter;
    capture.update = update;
    return query(null);
  };
  User.countDocuments = async () => 3;
  try {
    const { payload } = await invokeController(userController.removeFollower, {
      params: { username: "kojo" },
      user: { id: "owner-1" },
      validated: { params: { username: "kojo" } },
    });
    assert.equal(capture.filter.following, "owner-1");
    assert.deepEqual(capture.update, { $pull: { following: "owner-1" } });
    assert.equal(payload.data.removed, false);
    assert.equal(payload.data.followerCount, 3);
  } finally {
    User.countDocuments = originals.count;
    User.findOne = originals.findOne;
    User.findOneAndUpdate = originals.findOneAndUpdate;
  }
});
