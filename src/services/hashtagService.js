const GalleryPost = require("../models/GalleryPost");
const Hashtag = require("../models/Hashtag");
const Listing = require("../models/Listing");
const { normalizeHashtags } = require("../utils/hashtags");

const COUNTED_LISTING_STATUSES = new Set(["active", "sold"]);
const SOURCE_COUNT_FIELDS = {
  finspo: "finspoCount",
  listing: "listingCount",
};

const isPublishedListing = (listing) =>
  Boolean(listing && COUNTED_LISTING_STATUSES.has(String(listing.status || "active")));

const tagsForListing = (listing) =>
  isPublishedListing(listing) ? normalizeHashtags(listing.hashtags) : [];

const tagsForFinspo = (post) => (post ? normalizeHashtags(post.tags) : []);

const hashtagDiff = (beforeTags, afterTags) => {
  const before = new Set(normalizeHashtags(beforeTags));
  const after = new Set(normalizeHashtags(afterTags));

  return {
    added: [...after].filter((tag) => !before.has(tag)),
    removed: [...before].filter((tag) => !after.has(tag)),
  };
};

const isDuplicateKeyError = (error) =>
  error?.code === 11000 || error?.writeErrors?.some((entry) => entry?.code === 11000);

const incrementHashtag = async (name, sourceCountField, now = new Date(), Model = Hashtag) => {
  const update = {
    $inc: { postCount: 1, [sourceCountField]: 1 },
    $set: { lastUsedAt: now },
  };

  try {
    await Model.updateOne(
      { name },
      { ...update, $setOnInsert: { name } },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    // Another publisher inserted the same normalized tag between our match and
    // upsert. The failed upsert applied no increment, so retry against the winner.
    await Model.updateOne({ name }, update);
  }
};

const applyHashtagDiff = async ({ added, removed, source }) => {
  const sourceCountField = SOURCE_COUNT_FIELDS[source];
  if (!sourceCountField) throw new Error(`Unsupported hashtag source: ${source}`);

  const now = new Date();
  await Promise.all(added.map((name) => incrementHashtag(name, sourceCountField, now)));

  const operations = removed.map((name) => ({
    updateOne: {
      filter: {
        name,
        postCount: { $gt: 0 },
        [sourceCountField]: { $gt: 0 },
      },
      update: { $inc: { postCount: -1, [sourceCountField]: -1 } },
    },
  }));

  if (operations.length) {
    await Hashtag.bulkWrite(operations, { ordered: true });
  }
};

const syncListingHashtags = async (beforeListing, afterListing) =>
  applyHashtagDiff({
    ...hashtagDiff(tagsForListing(beforeListing), tagsForListing(afterListing)),
    source: "listing",
  });

const syncFinspoHashtags = async (beforePost, afterPost) =>
  applyHashtagDiff({
    ...hashtagDiff(tagsForFinspo(beforePost), tagsForFinspo(afterPost)),
    source: "finspo",
  });

const collectTagCounts = async (Model, match, field) => {
  const counts = new Map();
  const cursor = Model.find(match).select(field).lean().cursor();

  for await (const document of cursor) {
    normalizeHashtags(document[field]).forEach((name) => {
      counts.set(name, (counts.get(name) || 0) + 1);
    });
  }

  return counts;
};

const rebuildHashtagCounts = async () => {
  const [listingCounts, finspoCounts] = await Promise.all([
    collectTagCounts(Listing, { status: { $in: [...COUNTED_LISTING_STATUSES] } }, "hashtags"),
    collectTagCounts(GalleryPost, {}, "tags"),
  ]);

  const names = new Set([...listingCounts.keys(), ...finspoCounts.keys()]);
  await Hashtag.updateMany(
    {},
    { $set: { finspoCount: 0, listingCount: 0, postCount: 0 } },
  );

  if (!names.size) return 0;

  const now = new Date();
  await Hashtag.bulkWrite(
    [...names].map((name) => {
      const listingCount = listingCounts.get(name) || 0;
      const finspoCount = finspoCounts.get(name) || 0;
      return {
        updateOne: {
          filter: { name },
          update: {
            $set: {
              finspoCount,
              lastUsedAt: now,
              listingCount,
              postCount: listingCount + finspoCount,
            },
            $setOnInsert: { name },
          },
          upsert: true,
        },
      };
    }),
    { ordered: true },
  );

  return names.size;
};

module.exports = {
  COUNTED_LISTING_STATUSES,
  collectTagCounts,
  hashtagDiff,
  incrementHashtag,
  isDuplicateKeyError,
  isPublishedListing,
  rebuildHashtagCounts,
  syncFinspoHashtags,
  syncListingHashtags,
  tagsForFinspo,
  tagsForListing,
};
