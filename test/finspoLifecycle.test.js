const test = require("node:test");
const assert = require("node:assert/strict");
const GalleryPost = require("../src/models/GalleryPost");
const communityController = require("../src/controllers/communityController");
const communityRoutes = require("../src/routes/communityRoutes");
const { tagsForFinspo } = require("../src/services/hashtagService");
const {
  FINSPO_ARCHIVE_RETENTION_DAYS,
  FINSPO_ARCHIVE_RETENTION_MS,
  deleteExpiredArchivedFinspoPosts,
  expiredArchivedFinspoFilter,
  finspoArchiveExpiresAt,
  finspoArchiveTimestamp,
  finspoRestoreSnapshots,
  isArchivedFinspoExpired,
  unexpiredArchivedFinspoFilter,
} = require("../src/utils/finspoLifecycle");

test("Finspo archive expiry is exactly 30 days and prefers its scheduled deletion", () => {
  const archivedAt = new Date("2026-01-01T00:00:00.000Z");
  const derivedExpiry = new Date(archivedAt.getTime() + FINSPO_ARCHIVE_RETENTION_MS);

  assert.equal(FINSPO_ARCHIVE_RETENTION_DAYS, 30);
  assert.equal(finspoArchiveExpiresAt({ archivedAt }).toISOString(), derivedExpiry.toISOString());
  assert.equal(isArchivedFinspoExpired({ archivedAt, isArchived: true }, derivedExpiry), true);
  assert.equal(
    isArchivedFinspoExpired(
      { archivedAt, isArchived: true },
      new Date(derivedExpiry.getTime() - 1),
    ),
    false,
  );

  const scheduledDeletion = new Date("2026-03-01T00:00:00.000Z");
  const scheduledPost = { archiveDeleteAt: scheduledDeletion, archivedAt, isArchived: true };
  assert.equal(finspoArchiveExpiresAt(scheduledPost), scheduledDeletion);
  assert.equal(isArchivedFinspoExpired(scheduledPost, new Date("2026-02-01T00:00:00.000Z")), false);
});

test("legacy archived Finspo prefers immutable creation time and cannot be immortal", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const updatedAt = new Date("2026-02-01T00:00:00.000Z");
  assert.equal(finspoArchiveTimestamp({ createdAt, updatedAt }), createdAt);
  assert.equal(finspoArchiveTimestamp({ updatedAt }), updatedAt);
  assert.equal(
    isArchivedFinspoExpired(
      { isArchived: true, updatedAt },
      new Date(updatedAt.getTime() + FINSPO_ARCHIVE_RETENTION_MS),
    ),
    true,
  );
  assert.equal(isArchivedFinspoExpired({ isArchived: true }, new Date()), true);
  assert.equal(isArchivedFinspoExpired({ isArchived: false }, new Date()), false);
});

test("expiry filters enforce archiveDeleteAt immediately and retain legacy fallbacks", () => {
  const now = new Date("2026-04-15T12:00:00.000Z");
  const expired = expiredArchivedFinspoFilter(now);
  const unexpired = unexpiredArchivedFinspoFilter(now);

  assert.equal(expired.isArchived, true);
  assert.equal(expired.$or[0].archiveDeleteAt.$lte, now);
  assert.equal(unexpired.$or[0].archiveDeleteAt.$gt, now);
  assert.equal(expired.$or[1].archiveDeleteAt, null);
  assert.ok(expired.$or[1].archivedAt.$lte instanceof Date);
  assert.equal(unexpired.$or[1].archiveDeleteAt, null);
  assert.ok(unexpired.$or[1].archivedAt.$gt instanceof Date);
  assert.ok(expired.$or[2].createdAt.$lte instanceof Date);
  assert.equal(expired.$or[3].createdAt, null);
  assert.ok(expired.$or[3].updatedAt.$lte instanceof Date);
  assert.ok(unexpired.$or[2].createdAt.$gt instanceof Date);
  assert.equal(unexpired.$or[3].createdAt, null);
  assert.ok(unexpired.$or[3].updatedAt.$gt instanceof Date);
});

test("expired archive cleanup is bulk, idempotent, and uses the lifecycle filter", async () => {
  let receivedFilter;
  const Model = {
    deleteMany: async (filter) => {
      receivedFilter = filter;
      return { deletedCount: 3 };
    },
  };
  const now = new Date("2026-05-20T00:00:00.000Z");
  const deletedCount = await deleteExpiredArchivedFinspoPosts({ Model, now });

  assert.equal(deletedCount, 3);
  assert.equal(receivedFilter.isArchived, true);
  assert.equal(receivedFilter.$or[0].archiveDeleteAt.$lte, now);
});

test("restore snapshots re-enter hashtag counts without mutating the restored post", () => {
  const restoredPost = { isArchived: false, tags: ["streetwear", "y2k"] };
  const { after, before } = finspoRestoreSnapshots(restoredPost);

  assert.equal(restoredPost.isArchived, false);
  assert.equal(before.isArchived, true);
  assert.equal(after.isArchived, false);
  assert.deepEqual(tagsForFinspo(before), []);
  assert.deepEqual(tagsForFinspo(after), ["streetwear", "y2k"]);
});

test("gallery updates only look up active owner posts", async () => {
  const originalFindOne = GalleryPost.findOne;
  let receivedQuery;
  GalleryPost.findOne = async (query) => {
    receivedQuery = query;
    return null;
  };

  try {
    const error = await new Promise((resolve) => {
      communityController.updateGalleryPost(
        { params: { id: "post-id" }, user: { id: "owner-id" }, body: {} },
        {},
        resolve,
      );
    });

    assert.equal(error.statusCode, 404);
    assert.deepEqual(receivedQuery, {
      _id: "post-id",
      userId: "owner-id",
      isArchived: { $ne: true },
    });
  } finally {
    GalleryPost.findOne = originalFindOne;
  }
});

test("GalleryPost declares the named partial TTL archive index", () => {
  const ttlIndex = GalleryPost.schema.indexes().find(([, options]) =>
    options.name === "gallery_archived_expiry_ttl");

  assert.ok(ttlIndex);
  assert.deepEqual(ttlIndex[0], { archiveDeleteAt: 1 });
  assert.equal(ttlIndex[1].expireAfterSeconds, 0);
  assert.deepEqual(ttlIndex[1].partialFilterExpression, { isArchived: true });
});

test("community routes expose authenticated archived-list and restore actions", () => {
  const routeLayers = communityRoutes.stack.filter((layer) => layer.route);
  const routes = routeLayers.map((layer) => ({
    methods: layer.route.methods,
    path: layer.route.path,
  }));
  const archivedIndex = routes.findIndex(({ methods, path }) =>
    path === "/gallery/me/archived" && methods.get);
  const detailIndex = routes.findIndex(({ methods, path }) =>
    path === "/gallery/:id" && methods.get);

  assert.ok(archivedIndex >= 0);
  assert.ok(archivedIndex < detailIndex);
  assert.ok(routes.some(({ methods, path }) =>
    path === "/gallery/:id/restore" && methods.post));
  assert.equal(
    routeLayers.find((layer) => layer.route.path === "/gallery/me/archived").route.stack.length,
    2,
  );
  assert.equal(
    routeLayers.find((layer) => layer.route.path === "/gallery/:id/restore").route.stack.length,
    2,
  );
});
