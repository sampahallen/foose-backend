const FINSPO_ARCHIVE_RETENTION_DAYS = 30;
const FINSPO_ARCHIVE_RETENTION_MS = FINSPO_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const FINSPO_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const validDate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
};

const finspoArchiveTimestamp = (post) =>
  validDate(post?.archivedAt) || validDate(post?.createdAt) || validDate(post?.updatedAt);

const finspoArchiveExpiresAt = (post) => {
  const scheduledDeletion = validDate(post?.archiveDeleteAt);
  if (scheduledDeletion) return scheduledDeletion;
  const archivedAt = finspoArchiveTimestamp(post);
  return archivedAt ? new Date(archivedAt.getTime() + FINSPO_ARCHIVE_RETENTION_MS) : null;
};

const isArchivedFinspoExpired = (post, now = new Date()) => {
  if (!post?.isArchived) return false;
  const expiresAt = finspoArchiveExpiresAt(post);
  const currentTime = validDate(now);
  return !expiresAt || !currentTime || expiresAt <= currentTime;
};

const archivedFinspoCutoff = (now = new Date()) => {
  const currentTime = validDate(now) || new Date();
  return new Date(currentTime.getTime() - FINSPO_ARCHIVE_RETENTION_MS);
};

const expiredArchivedFinspoFilter = (now = new Date()) => {
  const currentTime = validDate(now) || new Date();
  const cutoff = archivedFinspoCutoff(now);
  return {
    isArchived: true,
    $or: [
      { archiveDeleteAt: { $lte: currentTime } },
      { archiveDeleteAt: null, archivedAt: { $lte: cutoff } },
      {
        archiveDeleteAt: null,
        archivedAt: null,
        createdAt: { $lte: cutoff },
      },
      {
        archiveDeleteAt: null,
        archivedAt: null,
        createdAt: null,
        updatedAt: { $lte: cutoff },
      },
      { archiveDeleteAt: null, archivedAt: null, createdAt: null, updatedAt: null },
    ],
  };
};

const unexpiredArchivedFinspoFilter = (now = new Date()) => {
  const currentTime = validDate(now) || new Date();
  const cutoff = archivedFinspoCutoff(now);
  return {
    isArchived: true,
    $or: [
      { archiveDeleteAt: { $gt: currentTime } },
      { archiveDeleteAt: null, archivedAt: { $gt: cutoff } },
      {
        archiveDeleteAt: null,
        archivedAt: null,
        createdAt: { $gt: cutoff },
      },
      {
        archiveDeleteAt: null,
        archivedAt: null,
        createdAt: null,
        updatedAt: { $gt: cutoff },
      },
    ],
  };
};

const finspoRestoreSnapshots = (restoredPost) => {
  const after = typeof restoredPost?.toObject === "function"
    ? restoredPost.toObject()
    : { ...(restoredPost || {}) };
  return {
    after,
    before: { ...after, isArchived: true },
  };
};

const deleteExpiredArchivedFinspoPosts = async ({ CommentModel, Model, now = new Date() } = {}) => {
  const GalleryPost = Model || require("../models/GalleryPost");
  const FinspoComment = CommentModel || require("../models/FinspoComment");
  const filter = expiredArchivedFinspoFilter(now);

  // Archiving already removed these posts from hashtag counts. Cleanup only
  // removes the excluded documents, avoiding a second decrement.
  if (typeof GalleryPost.find === "function") {
    const expiredPosts = await GalleryPost.find(filter).select("_id").lean();
    const postIds = expiredPosts.map((post) => post._id).filter(Boolean);
    if (!postIds.length) return 0;

    const result = await GalleryPost.deleteMany({ ...filter, _id: { $in: postIds } });
    const remainingPosts = await GalleryPost.find({ _id: { $in: postIds } })
      .select("_id")
      .lean();
    const remainingIds = new Set(remainingPosts.map((post) => post._id.toString()));
    const deletedPostIds = postIds.filter((postId) => !remainingIds.has(postId.toString()));

    if (deletedPostIds.length) {
      await FinspoComment.deleteMany({ postId: { $in: deletedPostIds } });
    }

    return Number(result?.deletedCount) || 0;
  }

  const result = await GalleryPost.deleteMany(filter);
  return Number(result?.deletedCount) || 0;
};

const startFinspoLifecycleCleanup = () => {
  const runCleanup = async () => {
    try {
      const deletedCount = await deleteExpiredArchivedFinspoPosts();
      if (deletedCount > 0) {
        console.log(`Deleted ${deletedCount} expired archived Finspo post(s)`);
      }
    } catch (error) {
      console.error("Finspo archive cleanup failed:", error.message);
    }
  };

  void runCleanup();
  const timer = setInterval(runCleanup, FINSPO_CLEANUP_INTERVAL_MS);
  timer.unref?.();
  return timer;
};

module.exports = {
  FINSPO_ARCHIVE_RETENTION_DAYS,
  FINSPO_ARCHIVE_RETENTION_MS,
  FINSPO_CLEANUP_INTERVAL_MS,
  archivedFinspoCutoff,
  deleteExpiredArchivedFinspoPosts,
  expiredArchivedFinspoFilter,
  finspoArchiveExpiresAt,
  finspoArchiveTimestamp,
  finspoRestoreSnapshots,
  isArchivedFinspoExpired,
  startFinspoLifecycleCleanup,
  unexpiredArchivedFinspoFilter,
};
