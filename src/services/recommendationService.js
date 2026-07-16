const DigiShop = require("../models/DigiShop");
const GalleryPost = require("../models/GalleryPost");
const Listing = require("../models/Listing");
const ShadowProfile = require("../models/ShadowProfile");
const User = require("../models/User");
const {
  DWELL_POINTS,
  RECOMMENDATION_FEED,
  RECOMMENDATION_POINTS,
  RECOMMENDATION_SIGNALS,
  SUGGESTED_FEED,
} = require("../constants/recommendations");
const { normalizeHashtags } = require("../utils/hashtags");
const { appendQueryClause, effectiveListingLocation, locationLabel } = require("../utils/location");
const { listingLocationClause } = require("./locationService");
const {
  composeFirstPage,
  composePersonalizedFeed,
  createSeededRandom,
  selectSuggestedCandidates,
  shuffled,
} = require("../utils/recommendationFeed");

const LISTING_POPULATE_FIELDS = "shopName slug rating totalReviews ownerId location";

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizedText = (value) =>
  String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const affinityKey = (value) =>
  normalizedText(value)
    .replace(/[.$]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 120);

const idValue = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value._id || value);
};

const uniqueValues = (values) =>
  Array.from(new Set((values || []).map(affinityKey).filter(Boolean)));

const listingAffinities = (listing) => {
  return {
    category: uniqueValues([listing?.category]),
    color: uniqueValues([listing?.color]),
    digishopId: uniqueValues([idValue(listing?.shopId)]),
    hashtags: uniqueValues(normalizeHashtags(listing?.hashtags)),
    location: uniqueValues([locationLabel(effectiveListingLocation(listing))]),
    size: uniqueValues([listing?.size]),
  };
};

const finspoAffinities = (post) => ({
  creatorId: uniqueValues([idValue(post?.userId)]),
  hashtags: uniqueValues(normalizeHashtags(post?.tags)),
});

const incrementAffinities = (increments, namespace, affinities, points) => {
  Object.entries(affinities).forEach(([field, values]) => {
    values.forEach((value) => {
      const path = `${namespace}.${field}.${value}`;
      increments[path] = (increments[path] || 0) + points;
    });
  });
};

const ensureShadowProfile = async (userId) => {
  if (!userId) return null;

  return ShadowProfile.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    { new: true, setDefaultsOnInsert: true, upsert: true },
  );
};

const backfillShadowProfiles = async () => {
  const users = await User.find({ accountStatus: { $ne: "deleted" } }).select("_id").lean();
  if (!users.length) return 0;

  const result = await ShadowProfile.bulkWrite(
    users.map((user) => ({
      updateOne: {
        filter: { userId: user._id },
        update: { $setOnInsert: { userId: user._id } },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  return result.upsertedCount || 0;
};

const awardProfile = async ({ finspo, item, points, signal, userId }) => {
  if (!userId || !Number.isFinite(points) || points === 0) return null;

  await ensureShadowProfile(userId);

  const increments = {};
  if (item) incrementAffinities(increments, "itemAffinities", item, points);
  if (finspo) incrementAffinities(increments, "finspoAffinities", finspo, points);
  increments[`signalCounts.${affinityKey(signal)}`] = 1;

  return ShadowProfile.findOneAndUpdate(
    { userId },
    {
      $inc: increments,
      $set: { lastSignalAt: new Date() },
    },
    { new: true },
  );
};

const signalPoints = (signal) => RECOMMENDATION_POINTS[signal] || 0;

const dwellPoints = (milliseconds) => {
  const duration = Number(milliseconds);
  if (!Number.isFinite(duration) || duration < 0) return 0;
  if (duration < 1000) return DWELL_POINTS.UNDER_ONE_SECOND;
  if (duration > 10000) return DWELL_POINTS.OVER_TEN_SECONDS;
  if (duration > 3000) return DWELL_POINTS.OVER_THREE_SECONDS;
  return 0;
};

const loadListing = (listingId) =>
  Listing.findOne({ _id: listingId, status: { $ne: "removed" } })
    .populate("shopId", LISTING_POPULATE_FIELDS)
    .lean();

const awardListingSignal = async (userId, listingId, signal, options = {}) => {
  const points = signal === RECOMMENDATION_SIGNALS.DWELL
    ? dwellPoints(options.dwellMs)
    : signalPoints(signal);

  if (!points) return null;

  const listing = await loadListing(idValue(listingId));
  if (!listing) return null;

  const ownerId = listing.shopId && typeof listing.shopId === "object"
    ? idValue(listing.shopId.ownerId)
    : "";
  if (ownerId && ownerId === idValue(userId)) return null;

  return awardProfile({
    item: listingAffinities(listing),
    points,
    signal,
    userId,
  });
};

const awardFinspoSignal = async (userId, postId, signal) => {
  const points = signalPoints(signal);
  if (!points) return null;

  const post = await GalleryPost.findById(postId).select("userId tags").lean();
  if (!post || idValue(post.userId) === idValue(userId)) return null;

  return awardProfile({
    finspo: finspoAffinities(post),
    points,
    signal,
    userId,
  });
};

const awardFinspoCreatorFollow = async (userId, creatorId) => {
  const posts = await GalleryPost.find({ userId: creatorId })
    .select("tags userId")
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  if (!posts.length) return null;

  const hashtags = uniqueValues(posts.flatMap((post) => normalizeHashtags(post.tags)));
  return awardProfile({
    finspo: {
      creatorId: uniqueValues([creatorId]),
      hashtags,
    },
    points: signalPoints(RECOMMENDATION_SIGNALS.FINSPO_CREATOR_FOLLOW),
    signal: RECOMMENDATION_SIGNALS.FINSPO_CREATOR_FOLLOW,
    userId,
  });
};

const awardPurchaseForOrder = async (order) => {
  const userId = idValue(order?.buyerId);
  const listingIds = (order?.items || []).map((item) => idValue(item.listingId)).filter(Boolean);

  await Promise.all(
    listingIds.map((listingId) =>
      awardListingSignal(userId, listingId, RECOMMENDATION_SIGNALS.PURCHASE)),
  );
};

const mapScore = (map, key) => {
  if (!map || !key) return 0;
  if (map instanceof Map) return Number(map.get(key) || 0);
  return Number(map[key] || 0);
};

const affinityScore = (namespace, field, values) =>
  uniqueValues(values).reduce((score, value) => score + mapScore(namespace?.[field], value), 0);

const scoreListing = (profile, listing) => {
  if (!profile) return 0;

  const item = listingAffinities(listing);
  const itemProfile = profile.itemAffinities || {};
  const finspoProfile = profile.finspoAffinities || {};
  const shop = listing?.shopId && typeof listing.shopId === "object" ? listing.shopId : null;
  const ownerId = affinityKey(idValue(shop?.ownerId));

  return (
    affinityScore(itemProfile, "category", item.category) +
    affinityScore(itemProfile, "color", item.color) +
    affinityScore(itemProfile, "digishopId", item.digishopId) +
    affinityScore(itemProfile, "hashtags", item.hashtags) +
    affinityScore(finspoProfile, "hashtags", item.hashtags) +
    affinityScore(itemProfile, "location", item.location) +
    affinityScore(itemProfile, "size", item.size) +
    mapScore(finspoProfile.creatorId, ownerId)
  );
};

const listingFilter = async (query, userId) => {
  const filter = { status: "active", visibility: { $ne: "event" } };
  const queryText = String(query.q || "").trim().replace(/^#+/, "");

  if (queryText) {
    const pattern = new RegExp(`\\b${escapeRegex(queryText)}`, "i");
    filter.$or = [
      { title: pattern },
      { brand: pattern },
      { category: pattern },
      { description: pattern },
      { hashtags: pattern },
    ];
  }

  ["category", "type", "condition", "color", "gender", "size", "brand"].forEach((field) => {
    if (query[field]) filter[field] = query[field];
  });

  if (query.minPrice || query.maxPrice) {
    filter.price = {};
    if (query.minPrice) filter.price.$gte = Number(query.minPrice);
    if (query.maxPrice) filter.price.$lte = Number(query.maxPrice);
  }

  let ownShopId = "";
  if (userId) {
    const ownShop = await DigiShop.findOne({ ownerId: userId }).select("_id").lean();
    ownShopId = idValue(ownShop?._id);
  }

  const locationFilter = { ...filter };
  if (ownShopId) locationFilter.shopId = { $ne: ownShopId };

  if (query.location) {
    appendQueryClause(filter, await listingLocationClause(query.location));
    if (ownShopId) filter.shopId = { $ne: ownShopId };
  } else if (ownShopId) {
    filter.shopId = { $ne: ownShopId };
  }

  return { filter, locationFilter };
};

const locationOptions = (listings) => {
  const values = new Map();

  listings.forEach((listing) => {
    const label = locationLabel(effectiveListingLocation(listing));
    if (label) values.set(normalizedText(label), { label, value: label });
  });

  return Array.from(values.values()).sort((left, right) => left.label.localeCompare(right.label));
};

const isPromoted = (listing, now = new Date()) =>
  listing.promotionTags?.includes("top-pick") &&
  listing.promotionExpiresAt &&
  new Date(listing.promotionExpiresAt) >= now;

const stableQuery = (query) => Object.keys(query)
  .filter((key) => !["limit", "page"].includes(key))
  .sort()
  .reduce((result, key) => {
    result[key] = query[key];
    return result;
  }, {});

const explicitSort = (listings, sort) => {
  const results = [...listings];
  if (sort === "price_asc") return results.sort((left, right) => left.price - right.price);
  if (sort === "price_desc") return results.sort((left, right) => right.price - left.price);
  if (sort === "popular") return results.sort((left, right) => (right.views || 0) - (left.views || 0));
  return null;
};

const buildRecommendationFeed = async ({ query, userId }) => {
  const page = Math.max(Number(query.page || 1), 1);
  const { filter, locationFilter } = await listingFilter(query, userId);
  const [candidates, locationCandidates] = await Promise.all([
    Listing.find(filter)
      .populate("shopId", LISTING_POPULATE_FIELDS)
      .sort({ createdAt: -1 })
      .limit(RECOMMENDATION_FEED.CANDIDATE_LIMIT)
      .lean(),
    query.location
      ? Listing.find(locationFilter)
          .populate("shopId", LISTING_POPULATE_FIELDS)
          .sort({ createdAt: -1 })
          .limit(RECOMMENDATION_FEED.CANDIDATE_LIMIT)
          .lean()
      : Promise.resolve(null),
  ]);
  const directSort = explicitSort(candidates, query.sort);

  let ordered = directSort;
  let feedMeta = {
    allocations: { new: 0, promoted: 0, suggested: 0 },
    candidateLimit: RECOMMENDATION_FEED.CANDIDATE_LIMIT,
    pageSize: RECOMMENDATION_FEED.PAGE_SIZE,
    personalized: Boolean(userId),
    promotedGap: 0,
    requestedPromotedGap: RECOMMENDATION_FEED.PROMOTED_REQUESTED_GAP,
  };

  if (!ordered) {
    if (userId) await ensureShadowProfile(userId);
    const profile = userId ? await ShadowProfile.findOne({ userId }).lean() : null;
    const seed = `${userId || "guest"}:${new Date().toISOString().slice(0, 10)}:${JSON.stringify(stableQuery(query))}`;
    const tieRandom = createSeededRandom(`${seed}:scores`);
    const scored = candidates.map((listing) => ({
      listing,
      score: scoreListing(profile, listing),
      tie: tieRandom(),
    }));
    const promotedCandidates = shuffled(
      candidates.filter((listing) => isPromoted(listing)),
      createSeededRandom(`${seed}:promoted`),
    );
    const promotedIds = new Set(promotedCandidates.map((listing) => idValue(listing._id)));
    const suggested = scored
      .filter(({ listing }) => !promotedIds.has(idValue(listing._id)))
      .sort((left, right) => right.score - left.score || left.tie - right.tie)
      .map(({ listing }) => listing);
    const newItems = candidates.filter((listing) => !promotedIds.has(idValue(listing._id)));
    const composed = composeFirstPage({
      fillers: suggested,
      newCount: RECOMMENDATION_FEED.NEW_COUNT,
      newItems,
      pageSize: RECOMMENDATION_FEED.PAGE_SIZE,
      promoted: promotedCandidates,
      promotedCount: RECOMMENDATION_FEED.PROMOTED_COUNT,
      requestedGap: RECOMMENDATION_FEED.PROMOTED_REQUESTED_GAP,
      seed: `${seed}:seats`,
      suggested,
      suggestedCount: RECOMMENDATION_FEED.SUGGESTED_COUNT,
    });
    const firstPageIds = new Set(composed.results.map((listing) => idValue(listing._id)));
    const remaining = scored
      .filter(({ listing }) => !firstPageIds.has(idValue(listing._id)))
      .sort((left, right) => right.score - left.score || left.tie - right.tie)
      .map(({ listing }) => listing);

    ordered = [...composed.results, ...remaining];
    feedMeta = {
      ...feedMeta,
      allocations: composed.allocations,
      promotedGap: composed.actualGap,
    };
  }

  const start = (page - 1) * RECOMMENDATION_FEED.PAGE_SIZE;
  const total = ordered.length;

  return {
    feed: feedMeta,
    filters: { locations: locationOptions(locationCandidates || candidates) },
    page,
    pages: Math.max(Math.ceil(total / RECOMMENDATION_FEED.PAGE_SIZE), 1),
    results: ordered.slice(start, start + RECOMMENDATION_FEED.PAGE_SIZE),
    total,
  };
};

const buildSuggestedFeed = async ({ query, userId }) => {
  const page = Math.max(Number(query.page || 1), 1);
  const { filter, locationFilter } = await listingFilter(query, userId);

  await ensureShadowProfile(userId);

  const [profile, candidates, locationCandidates] = await Promise.all([
    ShadowProfile.findOne({ userId }).lean(),
    Listing.find(filter)
      .populate("shopId", LISTING_POPULATE_FIELDS)
      .sort({ createdAt: -1 })
      .limit(SUGGESTED_FEED.CANDIDATE_LIMIT)
      .lean(),
    query.location
      ? Listing.find(locationFilter)
          .populate("shopId", LISTING_POPULATE_FIELDS)
          .sort({ createdAt: -1 })
          .limit(SUGGESTED_FEED.CANDIDATE_LIMIT)
          .lean()
      : Promise.resolve(null),
  ]);
  const seed = `${userId}:${new Date().toISOString().slice(0, 10)}:suggested:${JSON.stringify(stableQuery(query))}`;
  const tieRandom = createSeededRandom(`${seed}:scores`);
  const scored = candidates.map((listing) => ({
    listing,
    score: scoreListing(profile, listing),
    tie: tieRandom(),
  }));
  const selected = selectSuggestedCandidates({
    minimumScore: SUGGESTED_FEED.MINIMUM_SCORE,
    scoredCandidates: scored,
    seed,
  });
  const directSort = explicitSort(selected.results, query.sort);
  const orderedPersonalized = directSort || selected.results;
  const promoted = orderedPersonalized.filter((listing) => isPromoted(listing));
  const regular = orderedPersonalized.filter((listing) => !isPromoted(listing));
  const composed = composePersonalizedFeed({
    promoted,
    regular,
    requestedGap: SUGGESTED_FEED.PROMOTED_REQUESTED_GAP,
    seed: `${seed}:promoted-seats`,
  });
  const personalizedLocationCandidates = selected.personalized
    ? (locationCandidates || candidates)
        .filter((listing) => scoreListing(profile, listing) >= SUGGESTED_FEED.MINIMUM_SCORE)
    : (locationCandidates || candidates);
  const start = (page - 1) * SUGGESTED_FEED.PAGE_SIZE;
  const total = composed.results.length;

  return {
    feed: {
      allocations: {
        new: 0,
        promoted: composed.promotedCount,
        suggested: regular.length,
      },
      candidateLimit: SUGGESTED_FEED.CANDIDATE_LIMIT,
      pageSize: SUGGESTED_FEED.PAGE_SIZE,
      personalized: selected.personalized,
      promotedGap: composed.actualGap,
      requestedPromotedGap: composed.requestedGap,
    },
    filters: { locations: locationOptions(personalizedLocationCandidates) },
    page,
    pages: Math.max(Math.ceil(total / SUGGESTED_FEED.PAGE_SIZE), 1),
    results: composed.results.slice(start, start + SUGGESTED_FEED.PAGE_SIZE),
    total,
  };
};

module.exports = {
  awardFinspoCreatorFollow,
  awardFinspoSignal,
  awardListingSignal,
  awardPurchaseForOrder,
  backfillShadowProfiles,
  buildRecommendationFeed,
  buildSuggestedFeed,
  dwellPoints,
  ensureShadowProfile,
  scoreListing,
};
