const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const FinspoComment = require("../src/models/FinspoComment");
const GalleryPost = require("../src/models/GalleryPost");
const SearchDocument = require("../src/models/SearchDocument");
const User = require("../src/models/User");
const communityController = require("../src/controllers/communityController");
const communityRoutes = require("../src/routes/communityRoutes");
const auth = require("../src/middleware/authMiddleware");
const optionalAuth = require("../src/middleware/optionalAuthMiddleware");
const {
  deleteExpiredArchivedFinspoPosts,
  expiredArchivedFinspoFilter,
} = require("../src/utils/finspoLifecycle");

const routeFor = (method, path) => communityRoutes.stack.find(
  (layer) => layer.route?.path === path && layer.route.methods[method],
);

const runValidation = (middleware, { body, params }) => {
  const req = { body, params, query: {} };
  const result = { nextCalls: 0, payload: null, statusCode: null };
  const res = {
    status(statusCode) {
      result.statusCode = statusCode;
      return this;
    },
    json(payload) {
      result.payload = payload;
      return payload;
    },
  };

  middleware(req, res, () => {
    result.nextCalls += 1;
  });

  return { req, ...result };
};

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

  controller(req, res, (error) => {
    reject(error || new Error("Controller called next without a response"));
  });
});

const leanQuery = (value) => ({
  lean: async () => value,
  select() {
    return this;
  },
});

const listQuery = (value) => ({
  lean: async () => value,
  limit() {
    return this;
  },
  populate() {
    return this;
  },
  skip() {
    return this;
  },
  sort() {
    return this;
  },
});

test("FinspoComment declares the reply, like, count, and post-expiry contract", () => {
  const requiredRefs = {
    postId: "GalleryPost",
    userId: "User",
  };

  for (const [pathName, ref] of Object.entries(requiredRefs)) {
    const path = FinspoComment.schema.path(pathName);
    assert.ok(path, `${pathName} is declared`);
    assert.equal(path.instance, "ObjectId");
    assert.equal(path.options.ref, ref);
    assert.equal(path.options.required, true);
  }

  for (const [pathName, ref] of Object.entries({
    replyToCommentId: "FinspoComment",
    replyToUserId: "User",
    rootCommentId: "FinspoComment",
  })) {
    const path = FinspoComment.schema.path(pathName);
    assert.ok(path, `${pathName} is declared`);
    assert.equal(path.instance, "ObjectId");
    assert.equal(path.options.ref, ref);
  }

  const bodyPath = FinspoComment.schema.path("body");
  assert.ok(bodyPath);
  assert.equal(bodyPath.options.required, true);
  assert.equal(bodyPath.options.trim, true);

  const likesPath = FinspoComment.schema.path("likes");
  assert.equal(likesPath.instance, "Array");
  assert.equal(likesPath.embeddedSchemaType.options.ref, "User");
  assert.equal(FinspoComment.schema.path("postDeleteAt").instance, "Date");

  const comment = new FinspoComment({
    body: "A comment",
    postId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
  });
  assert.deepEqual(comment.likes, []);
  assert.equal(comment.replyCount, 0);

  const ttlIndex = FinspoComment.schema.indexes().find(([, options]) =>
    options.name === "finspo_comment_post_expiry_ttl");
  assert.ok(ttlIndex);
  assert.deepEqual(ttlIndex[0], { postDeleteAt: 1 });
  assert.equal(ttlIndex[1].expireAfterSeconds, 0);

  const postCommentCount = GalleryPost.schema.path("commentCount");
  assert.ok(postCommentCount);
  assert.equal(postCommentCount.instance, "Number");
  assert.equal(new GalleryPost({ imageUrl: "https://example.com/post.jpg", userId: new mongoose.Types.ObjectId() }).commentCount, 0);
});

test("community routes expose the Finspo comment endpoints with the intended auth", () => {
  const routeContracts = [
    ["get", "/gallery/:id/comments", optionalAuth, communityController.listFinspoComments],
    [
      "get",
      "/gallery/:id/comments/:commentId/replies",
      optionalAuth,
      communityController.listFinspoCommentReplies,
    ],
    ["post", "/gallery/:id/comments", auth, communityController.createFinspoComment],
    [
      "post",
      "/gallery/:id/comments/:commentId/replies",
      auth,
      communityController.createFinspoCommentReply,
    ],
    [
      "post",
      "/gallery/:id/comments/:commentId/like",
      auth,
      communityController.toggleFinspoCommentLike,
    ],
  ];

  for (const [method, path, authMiddleware, controller] of routeContracts) {
    const layer = routeFor(method, path);
    assert.ok(layer, `${method.toUpperCase()} ${path} is registered`);
    assert.equal(layer.route.stack[0].handle, authMiddleware, `${method.toUpperCase()} ${path} auth`);
    assert.equal(layer.route.stack.at(-1).handle, controller, `${method.toUpperCase()} ${path} controller`);
  }

  const routes = communityRoutes.stack.filter((layer) => layer.route);
  const commentsIndex = routes.findIndex((layer) => layer.route.path === "/gallery/:id/comments");
  const detailIndex = routes.findIndex((layer) => layer.route.path === "/gallery/:id");
  assert.ok(commentsIndex >= 0);
  assert.ok(commentsIndex < detailIndex);
});

test("Finspo comment and reply validators reject blank or spoofed authors", () => {
  const contracts = [
    {
      params: { id: "64b000000000000000000001" },
      route: routeFor("post", "/gallery/:id/comments"),
    },
    {
      params: {
        commentId: "64b000000000000000000002",
        id: "64b000000000000000000001",
      },
      route: routeFor("post", "/gallery/:id/comments/:commentId/replies"),
    },
  ];

  for (const { params, route } of contracts) {
    assert.ok(route);
    assert.equal(route.route.stack.length, 3);
    const validation = route.route.stack[1].handle;

    const blank = runValidation(validation, { body: { body: "   " }, params });
    assert.equal(blank.nextCalls, 0);
    assert.equal(blank.statusCode, 422);
    assert.equal(blank.payload.error, "Validation failed");

    const spoofed = runValidation(validation, {
      body: { body: "Looks valid", userId: "another-user" },
      params,
    });
    assert.equal(spoofed.nextCalls, 0);
    assert.equal(spoofed.statusCode, 422);

    const valid = runValidation(validation, { body: { body: "Looks valid" }, params });
    assert.equal(valid.nextCalls, 1);
    assert.equal(valid.statusCode, null);
    assert.equal(valid.req.body.body, "Looks valid");
  }
});

test("comment listing uses the frontend field names and includes the post-wide total", async () => {
  const originalPostFindOne = GalleryPost.findOne;
  const originalCommentFind = FinspoComment.find;
  const originalCommentCountDocuments = FinspoComment.countDocuments;
  const postId = new mongoose.Types.ObjectId();
  const viewerId = new mongoose.Types.ObjectId();
  const userId = {
    _id: new mongoose.Types.ObjectId(),
    username: "commenter",
  };
  const comment = {
    _id: new mongoose.Types.ObjectId(),
    body: "A useful comment",
    createdAt: new Date("2026-07-16T10:00:00.000Z"),
    likes: [viewerId],
    postId,
    replyCount: 2,
    replyToCommentId: null,
    replyToUserId: null,
    rootCommentId: null,
    updatedAt: new Date("2026-07-16T10:00:00.000Z"),
    userId,
  };

  GalleryPost.findOne = () => leanQuery({ _id: postId, commentCount: 7 });
  FinspoComment.find = () => listQuery([comment]);
  FinspoComment.countDocuments = async () => 1;

  try {
    const { payload, statusCode } = await invokeController(
      communityController.listFinspoComments,
      {
        params: { id: postId.toString() },
        query: {},
        user: { id: viewerId.toString() },
      },
    );

    assert.equal(statusCode, 200);
    assert.equal(payload.data.total, 1);
    assert.equal(payload.data.totalComments, 7);
    assert.equal(payload.data.comments.length, 1);
    assert.equal(payload.data.comments[0].userId, userId);
    assert.equal(payload.data.comments[0].replyToUserId, null);
    assert.equal(payload.data.comments[0].liked, true);
    assert.equal(payload.data.comments[0].likeCount, 1);
    assert.equal("author" in payload.data.comments[0], false);
    assert.equal("replyToUser" in payload.data.comments[0], false);
  } finally {
    GalleryPost.findOne = originalPostFindOne;
    FinspoComment.find = originalCommentFind;
    FinspoComment.countDocuments = originalCommentCountDocuments;
  }
});

test("comment creation returns the serialized comment and updated total", async () => {
  const originalPostFindOne = GalleryPost.findOne;
  const originalPostFindOneAndUpdate = GalleryPost.findOneAndUpdate;
  const originalCommentCreate = FinspoComment.create;
  const postId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const comment = {
    _id: new mongoose.Types.ObjectId(),
    body: "New comment",
    createdAt: new Date(),
    likes: [],
    populate: async () => comment,
    postId,
    replyCount: 0,
    replyToCommentId: null,
    replyToUserId: null,
    rootCommentId: null,
    updatedAt: new Date(),
    userId: { _id: userId, username: "member" },
  };

  GalleryPost.findOne = () => leanQuery({ _id: postId });
  GalleryPost.findOneAndUpdate = () => ({
    select: async () => ({ _id: postId, commentCount: 4 }),
  });
  FinspoComment.create = async () => comment;

  try {
    const { payload, statusCode } = await invokeController(
      communityController.createFinspoComment,
      {
        body: { body: comment.body },
        params: { id: postId.toString() },
        user: { id: userId.toString() },
      },
    );

    assert.equal(statusCode, 201);
    assert.deepEqual(Object.keys(payload.data).sort(), ["comment", "totalComments"]);
    assert.equal(payload.data.comment.userId, comment.userId);
    assert.equal(payload.data.totalComments, 4);
  } finally {
    GalleryPost.findOne = originalPostFindOne;
    GalleryPost.findOneAndUpdate = originalPostFindOneAndUpdate;
    FinspoComment.create = originalCommentCreate;
  }
});

test("reply creation stays flat and returns both updated counters", async () => {
  const originalPostFindOne = GalleryPost.findOne;
  const originalPostFindOneAndUpdate = GalleryPost.findOneAndUpdate;
  const originalCommentCreate = FinspoComment.create;
  const originalCommentFindOne = FinspoComment.findOne;
  const originalCommentFindOneAndUpdate = FinspoComment.findOneAndUpdate;
  const postId = new mongoose.Types.ObjectId();
  const rootId = new mongoose.Types.ObjectId();
  const targetId = new mongoose.Types.ObjectId();
  const targetUserId = new mongoose.Types.ObjectId();
  const replyingUserId = new mongoose.Types.ObjectId();
  let findOneCalls = 0;
  let createdFields;
  const reply = {
    _id: new mongoose.Types.ObjectId(),
    body: "Replying to a reply",
    createdAt: new Date(),
    likes: [],
    populate: async () => reply,
    postId,
    replyCount: 0,
    replyToCommentId: targetId,
    replyToUserId: { _id: targetUserId, username: "target" },
    rootCommentId: rootId,
    updatedAt: new Date(),
    userId: { _id: replyingUserId, username: "replier" },
  };

  GalleryPost.findOne = () => leanQuery({ _id: postId });
  GalleryPost.findOneAndUpdate = () => ({
    select: async () => ({ _id: postId, commentCount: 9 }),
  });
  FinspoComment.findOne = () => {
    findOneCalls += 1;
    return {
      select: async () => findOneCalls === 1
        ? { _id: targetId, rootCommentId: rootId, userId: targetUserId }
        : { _id: rootId },
    };
  };
  FinspoComment.create = async (fields) => {
    createdFields = fields;
    return reply;
  };
  FinspoComment.findOneAndUpdate = () => ({
    select: async () => ({ _id: rootId, replyCount: 3 }),
  });

  try {
    const { payload, statusCode } = await invokeController(
      communityController.createFinspoCommentReply,
      {
        body: { body: reply.body },
        params: { commentId: targetId.toString(), id: postId.toString() },
        user: { id: replyingUserId.toString() },
      },
    );

    assert.equal(statusCode, 201);
    assert.equal(createdFields.rootCommentId, rootId);
    assert.equal(createdFields.replyToCommentId, targetId);
    assert.equal(createdFields.replyToUserId, targetUserId);
    assert.deepEqual(Object.keys(payload.data).sort(), [
      "reply",
      "rootCommentId",
      "rootReplyCount",
      "totalComments",
    ]);
    assert.equal(payload.data.reply.userId, reply.userId);
    assert.equal(payload.data.reply.replyToUserId, reply.replyToUserId);
    assert.equal(payload.data.rootCommentId, rootId);
    assert.equal(payload.data.rootReplyCount, 3);
    assert.equal(payload.data.totalComments, 9);
  } finally {
    GalleryPost.findOne = originalPostFindOne;
    GalleryPost.findOneAndUpdate = originalPostFindOneAndUpdate;
    FinspoComment.create = originalCommentCreate;
    FinspoComment.findOne = originalCommentFindOne;
    FinspoComment.findOneAndUpdate = originalCommentFindOneAndUpdate;
  }
});

test("comment like response is the compact counter contract", async () => {
  const originalPostFindOne = GalleryPost.findOne;
  const originalCommentFindOne = FinspoComment.findOne;
  const postId = new mongoose.Types.ObjectId();
  const commentId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const comment = {
    _id: commentId,
    body: "Liked comment",
    likes: [],
    populate: async () => comment,
    postId,
    replyCount: 0,
    save: async () => comment,
    userId: new mongoose.Types.ObjectId(),
  };

  GalleryPost.findOne = () => leanQuery({ _id: postId });
  FinspoComment.findOne = async () => comment;

  try {
    const { payload, statusCode } = await invokeController(
      communityController.toggleFinspoCommentLike,
      {
        params: { commentId: commentId.toString(), id: postId.toString() },
        user: { id: userId.toString() },
      },
    );

    assert.equal(statusCode, 200);
    assert.deepEqual(Object.keys(payload.data).sort(), ["commentId", "likeCount", "liked"]);
    assert.equal(payload.data.commentId.toString(), commentId.toString());
    assert.equal(payload.data.liked, true);
    assert.equal(payload.data.likeCount, 1);
  } finally {
    GalleryPost.findOne = originalPostFindOne;
    FinspoComment.findOne = originalCommentFindOne;
  }
});

test("expired Finspo cleanup removes associated comments after their posts", async () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const postIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const calls = [];
  const receivedFindFilters = [];
  let receivedPostDeleteFilter;
  let receivedCommentDeleteFilter;
  const Model = {
    find(filter) {
      receivedFindFilters.push(filter);
      const value = receivedFindFilters.length === 1
        ? postIds.map((_id) => ({ _id }))
        : [];
      return {
        select(selection) {
          assert.equal(selection, "_id");
          return {
            lean: async () => value,
          };
        },
      };
    },
    async deleteMany(filter) {
      calls.push("posts");
      receivedPostDeleteFilter = filter;
      return { deletedCount: postIds.length };
    },
  };
  const CommentModel = {
    async deleteMany(filter) {
      calls.push("comments");
      receivedCommentDeleteFilter = filter;
      return { deletedCount: 5 };
    },
  };

  const deletedCount = await deleteExpiredArchivedFinspoPosts({ CommentModel, Model, now });

  assert.equal(deletedCount, postIds.length);
  assert.deepEqual(receivedFindFilters, [
    expiredArchivedFinspoFilter(now),
    { _id: { $in: postIds } },
  ]);
  assert.deepEqual(receivedCommentDeleteFilter, { postId: { $in: postIds } });
  assert.deepEqual(receivedPostDeleteFilter, {
    ...expiredArchivedFinspoFilter(now),
    _id: { $in: postIds },
  });
  assert.deepEqual(calls, ["posts", "comments"]);
});

test("expired cleanup retains comments for a candidate restored during deletion", async () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const deletedPostId = new mongoose.Types.ObjectId();
  const restoredPostId = new mongoose.Types.ObjectId();
  const postIds = [deletedPostId, restoredPostId];
  const calls = [];
  const findFilters = [];
  let receivedCommentDeleteFilter;
  const Model = {
    find(filter) {
      findFilters.push(filter);
      const value = findFilters.length === 1
        ? postIds.map((_id) => ({ _id }))
        : [{ _id: restoredPostId }];
      return {
        select() {
          return {
            lean: async () => value,
          };
        },
      };
    },
    async deleteMany() {
      calls.push("posts");
      return { deletedCount: 1 };
    },
  };
  const CommentModel = {
    async deleteMany(filter) {
      calls.push("comments");
      receivedCommentDeleteFilter = filter;
      return { deletedCount: 4 };
    },
  };

  const deletedCount = await deleteExpiredArchivedFinspoPosts({ CommentModel, Model, now });

  assert.equal(deletedCount, 1);
  assert.deepEqual(findFilters, [
    expiredArchivedFinspoFilter(now),
    { _id: { $in: postIds } },
  ]);
  assert.deepEqual(receivedCommentDeleteFilter, {
    postId: { $in: [deletedPostId] },
  });
  assert.deepEqual(calls, ["posts", "comments"]);
});

test("expired Finspo cleanup skips comment deletion when no archived posts qualify", async () => {
  let commentDeletes = 0;
  let postDeletes = 0;
  const Model = {
    find: () => ({
      select: () => ({
        lean: async () => [],
      }),
    }),
    deleteMany: async () => {
      postDeletes += 1;
      return { deletedCount: 0 };
    },
  };
  const CommentModel = {
    deleteMany: async () => {
      commentDeletes += 1;
      return { deletedCount: 0 };
    },
  };

  assert.equal(await deleteExpiredArchivedFinspoPosts({ CommentModel, Model }), 0);
  assert.equal(commentDeletes, 0);
  assert.equal(postDeletes, 0);
});

test("archiving synchronizes the post deletion deadline onto its comments", async () => {
  const originalPostFindById = GalleryPost.findById;
  const originalPostFindOne = GalleryPost.findOne;
  const originalCommentUpdateMany = FinspoComment.updateMany;
  const originalSearchDeleteOne = SearchDocument.deleteOne;
  const originalUserFindOne = User.findOne;
  const postId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  let commentFilter;
  let commentUpdate;
  const post = {
    _id: postId,
    archiveDeleteAt: null,
    archivedAt: null,
    isArchived: false,
    save: async () => post,
    tags: [],
    toObject: () => ({
      _id: postId,
      archiveDeleteAt: null,
      archivedAt: null,
      isArchived: false,
      tags: [],
    }),
    userId: ownerId,
  };

  GalleryPost.findOne = async () => post;
  GalleryPost.findById = () => leanQuery(post);
  User.findOne = () => leanQuery({ _id: ownerId, username: "owner" });
  SearchDocument.deleteOne = async () => ({ deletedCount: 1 });
  FinspoComment.updateMany = async (filter, update) => {
    commentFilter = filter;
    commentUpdate = update;
    return { modifiedCount: 3 };
  };

  try {
    const { statusCode } = await invokeController(
      communityController.archiveGalleryPost,
      {
        params: { id: postId.toString() },
        user: { id: ownerId.toString() },
      },
    );

    assert.equal(statusCode, 200);
    assert.equal(post.isArchived, true);
    assert.ok(post.archivedAt instanceof Date);
    assert.ok(post.archiveDeleteAt instanceof Date);
    assert.deepEqual(commentFilter, { postId });
    assert.equal(commentUpdate.$set.postDeleteAt, post.archiveDeleteAt);
  } finally {
    GalleryPost.findById = originalPostFindById;
    GalleryPost.findOne = originalPostFindOne;
    FinspoComment.updateMany = originalCommentUpdateMany;
    SearchDocument.deleteOne = originalSearchDeleteOne;
    User.findOne = originalUserFindOne;
  }
});

test("restoring a Finspo post clears the comment deletion deadline", async () => {
  const originalPostFindById = GalleryPost.findById;
  const originalPostFindOneAndUpdate = GalleryPost.findOneAndUpdate;
  const originalCommentUpdateMany = FinspoComment.updateMany;
  const originalSearchUpdateOne = SearchDocument.updateOne;
  const originalUserFindOne = User.findOne;
  const postId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  let commentFilter;
  let commentUpdate;
  const post = {
    _id: postId,
    isArchived: false,
    populate: async () => post,
    tags: [],
    userId: ownerId,
  };

  GalleryPost.findOneAndUpdate = async () => post;
  GalleryPost.findById = () => leanQuery({
    ...post,
    caption: "",
    createdAt: new Date("2026-07-16T10:00:00.000Z"),
    updatedAt: new Date("2026-07-16T10:00:00.000Z"),
  });
  User.findOne = () => leanQuery({ _id: ownerId, username: "owner" });
  SearchDocument.updateOne = async () => ({ upsertedCount: 1 });
  FinspoComment.updateMany = async (filter, update) => {
    commentFilter = filter;
    commentUpdate = update;
    return { modifiedCount: 3 };
  };

  try {
    const { statusCode } = await invokeController(
      communityController.restoreGalleryPost,
      {
        params: { id: postId.toString() },
        user: { id: ownerId.toString() },
      },
    );

    assert.equal(statusCode, 200);
    assert.deepEqual(commentFilter, { postId });
    assert.deepEqual(commentUpdate, { $unset: { postDeleteAt: "" } });
  } finally {
    GalleryPost.findById = originalPostFindById;
    GalleryPost.findOneAndUpdate = originalPostFindOneAndUpdate;
    FinspoComment.updateMany = originalCommentUpdateMany;
    SearchDocument.updateOne = originalSearchUpdateOne;
    User.findOne = originalUserFindOne;
  }
});
