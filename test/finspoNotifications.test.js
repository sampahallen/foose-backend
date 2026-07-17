const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const FinspoComment = require("../src/models/FinspoComment");
const GalleryPost = require("../src/models/GalleryPost");
const Notification = require("../src/models/Notification");
const communityController = require("../src/controllers/communityController");
const communityRoutes = require("../src/routes/communityRoutes");
const optionalAuth = require("../src/middleware/optionalAuthMiddleware");
const { createNotification } = require("../src/services/notificationService");
const {
  commentLink,
  notifyFinspoComment,
  notifyFinspoCommentLike,
  notifyFinspoPostLike,
  notifyFinspoReply,
} = require("../src/services/finspoNotificationService");

const routeFor = (method, path) => communityRoutes.stack.find(
  (layer) => layer.route?.path === path && layer.route.methods[method],
);

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

const leanQuery = (value) => ({
  lean: async () => value,
  select() {
    return this;
  },
});

const populatedLeanQuery = (value) => ({
  lean: async () => value,
  populate() {
    return this;
  },
});

test("notifications declare a unique per-user event key", () => {
  const eventKey = Notification.schema.path("eventKey");
  assert.ok(eventKey);
  assert.equal(eventKey.instance, "String");
  assert.equal(eventKey.options.select, false);

  const index = Notification.schema.indexes().find(([, options]) =>
    options.name === "notification_user_event_unique");
  assert.ok(index);
  assert.deepEqual(index[0], { userId: 1, eventKey: 1 });
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, { eventKey: { $type: "string" } });

  const publicPayload = new Notification({
    body: "Body",
    eventKey: "internal-event",
    title: "Title",
    type: "system",
    userId: new mongoose.Types.ObjectId(),
  }).toJSON();
  assert.equal("eventKey" in publicPayload, false, "eventKey stays out of REST and socket JSON");
});

test("notifications declare the named unread inbox index", () => {
  const index = Notification.schema.indexes().find(([, options]) =>
    options.name === "notification_user_read_created");
  assert.ok(index);
  assert.deepEqual(index[0], { userId: 1, isRead: 1, createdAt: -1 });
});

test("notification service treats duplicate event keys as the existing notification", async () => {
  const originalCreate = Notification.create;
  const originalFindOne = Notification.findOne;
  const existing = { _id: new mongoose.Types.ObjectId(), eventKey: "same-event" };
  let findFilter;
  Notification.create = async () => {
    const error = new Error("duplicate");
    error.code = 11000;
    throw error;
  };
  Notification.findOne = async (filter) => {
    findFilter = filter;
    return existing;
  };

  try {
    const userId = new mongoose.Types.ObjectId();
    const result = await createNotification({
      body: "Already sent",
      eventKey: "same-event",
      link: "/somewhere",
      title: "Duplicate",
      type: "system",
      userId,
    });
    assert.equal(result, existing);
    assert.equal(findFilter.userId, userId);
    assert.equal(findFilter.eventKey, "same-event");
  } finally {
    Notification.create = originalCreate;
    Notification.findOne = originalFindOne;
  }
});

test("Finspo activity notifications suppress self activity and use exact deduplicated links", async () => {
  const originalCreate = Notification.create;
  const created = [];
  Notification.create = async (payload) => {
    created.push(payload);
    return { _id: new mongoose.Types.ObjectId(), ...payload };
  };

  const actorId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const postId = new mongoose.Types.ObjectId();
  const rootId = new mongoose.Types.ObjectId();
  const replyId = new mongoose.Types.ObjectId();
  const actor = { _id: actorId, name: "Alex", username: "alex" };

  try {
    await notifyFinspoPostLike({ actor, postId, recipientId: ownerId });
    await notifyFinspoComment({
      actor,
      comment: { _id: rootId, body: "A thoughtful comment" },
      postId,
      recipientId: ownerId,
    });
    await notifyFinspoReply({
      actor,
      postId,
      recipientId: ownerId,
      reply: { _id: replyId, body: "A direct reply", rootCommentId: rootId },
    });
    await notifyFinspoCommentLike({
      actor,
      comment: { _id: replyId, rootCommentId: rootId },
      postId,
      recipientId: ownerId,
    });
    await notifyFinspoPostLike({ actor, postId, recipientId: actorId });

    assert.equal(created.length, 4, "self-like does not create a notification");
    assert.equal(created[0].link, `/community/finspo/${postId}`);
    assert.equal(created[1].link, `/community/finspo/${postId}?comments=1&comment=${rootId}`);
    assert.equal(created[2].link, commentLink(postId, replyId));
    assert.equal(created[3].link, commentLink(postId, replyId));
    assert.equal(created[0].eventKey, `finspo:post:${postId}:like:${actorId}`);
    assert.equal(created[3].eventKey, `finspo:comment:${replyId}:like:${actorId}`);
    assert.ok(created.every((notification) => notification.type === "system"));
  } finally {
    Notification.create = originalCreate;
  }
});

test("comment context is optional-auth, returns the root and exact nested reply", async () => {
  const route = routeFor("get", "/gallery/:id/comments/:commentId/context");
  assert.ok(route);
  assert.equal(route.route.stack[0].handle, optionalAuth);
  assert.equal(route.route.stack.at(-1).handle, communityController.getFinspoCommentContext);

  const originalPostFindOne = GalleryPost.findOne;
  const originalCommentFindOne = FinspoComment.findOne;
  const postId = new mongoose.Types.ObjectId();
  const rootId = new mongoose.Types.ObjectId();
  const replyId = new mongoose.Types.ObjectId();
  const viewerId = new mongoose.Types.ObjectId();
  const author = { _id: new mongoose.Types.ObjectId(), name: "Author", username: "author" };
  const root = {
    _id: rootId,
    body: "Root",
    likes: [],
    postId,
    replyCount: 4,
    rootCommentId: null,
    userId: author,
  };
  const reply = {
    _id: replyId,
    body: "Focused reply",
    likes: [viewerId],
    postId,
    replyCount: 0,
    replyToCommentId: rootId,
    replyToUserId: author,
    rootCommentId: rootId,
    userId: author,
  };
  let commentCall = 0;
  GalleryPost.findOne = () => leanQuery({ _id: postId, commentCount: 8 });
  FinspoComment.findOne = () => {
    commentCall += 1;
    return populatedLeanQuery(commentCall === 1 ? reply : root);
  };

  try {
    const { payload } = await invokeController(communityController.getFinspoCommentContext, {
      params: { commentId: replyId.toString(), id: postId.toString() },
      query: {},
      user: { id: viewerId.toString() },
    });
    assert.equal(payload.data.isReply, true);
    assert.equal(payload.data.rootComment._id, rootId);
    assert.equal(payload.data.rootCommentId, rootId);
    assert.equal(payload.data.target._id, replyId);
    assert.equal(payload.data.target.liked, true);
    assert.equal(payload.data.totalComments, 8);
  } finally {
    GalleryPost.findOne = originalPostFindOne;
    FinspoComment.findOne = originalCommentFindOne;
  }
});

test("comment likes notify only on the positive transition", async () => {
  const originalPostFindOne = GalleryPost.findOne;
  const originalCommentFindOne = FinspoComment.findOne;
  const originalNotificationCreate = Notification.create;
  const postId = new mongoose.Types.ObjectId();
  const commentId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const created = [];
  const comment = {
    _id: commentId,
    likes: [],
    postId,
    rootCommentId: null,
    save: async () => comment,
    userId: ownerId,
  };
  GalleryPost.findOne = () => leanQuery({ _id: postId });
  FinspoComment.findOne = async () => comment;
  Notification.create = async (payload) => {
    created.push(payload);
    return payload;
  };

  const request = {
    currentUser: { _id: actorId, username: "liker" },
    params: { commentId: commentId.toString(), id: postId.toString() },
    user: { id: actorId.toString(), username: "liker" },
  };

  try {
    const liked = await invokeController(communityController.toggleFinspoCommentLike, request);
    assert.equal(liked.payload.data.liked, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created.length, 1);

    const unliked = await invokeController(communityController.toggleFinspoCommentLike, request);
    assert.equal(unliked.payload.data.liked, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created.length, 1, "unlike does not create another notification");
  } finally {
    GalleryPost.findOne = originalPostFindOne;
    FinspoComment.findOne = originalCommentFindOne;
    Notification.create = originalNotificationCreate;
  }
});
