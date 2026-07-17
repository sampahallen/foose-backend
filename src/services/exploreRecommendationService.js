const crypto = require("crypto");
const DigiShop = require("../models/DigiShop");
const Event = require("../models/Event");
const GalleryPost = require("../models/GalleryPost");
const Listing = require("../models/Listing");
const ShadowProfile = require("../models/ShadowProfile");
const User = require("../models/User");
const { EXPLORE_FEED } = require("../constants/recommendations");
const { normalizeHashtags } = require("../utils/hashtags");
const httpError = require("../utils/httpError");
const {
  composeExploreFeed,
  decodeExploreCursor,
  encodeExploreCursor,
  orderExploreBatch,
  selectExplorePersonalizedKeys,
  trailingDiversityState,
} = require("../utils/exploreFeed");
const { scoreFinspo, scoreListing } = require("./recommendationService");

const ACTIVE_ACCOUNT_FILTER = {
  $or: [{ accountStatus: "active" }, { accountStatus: { $exists: false } }],
};
const TYPES = ["item", "finspo", "event", "user"];

const idValue = (value) => String(value?._id || value || "");
const valuesById = (values) => new Map(values.map((value) => [idValue(value), value]));
const normalizeKey = (value) =>
  String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[.$]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 120);
const mapScore = (map, key) => {
  if (!map || !key) return 0;
  if (map instanceof Map) return Number(map.get(key) || 0);
  return Number(map[key] || 0);
};
const affinityScore = (namespace, field, values) =>
  Array.from(new Set(values.map(normalizeKey).filter(Boolean)))
    .reduce((total, value) => total + mapScore(namespace?.[field], value), 0);

const safeShop = (shop) => shop && ({
  _id: shop._id,
  bio: shop.bio || "",
  category: shop.category,
  isLive: shop.isLive,
  location: shop.location,
  logoUrl: shop.logoUrl,
  ownerId: shop.ownerId,
  rating: shop.rating || 0,
  shopName: shop.shopName,
  slug: shop.slug,
  totalReviews: shop.totalReviews || 0,
});

const eventExpiry = (event) => {
  if (event?.endsAt) {
    const explicit = new Date(event.endsAt);
    return Number.isNaN(explicit.valueOf()) ? null : explicit;
  }
  if (!event?.date) return null;
  const expiry = new Date(event.date);
  if (Number.isNaN(expiry.valueOf())) return null;
  expiry.setUTCHours(23, 59, 59, 999);
  return expiry;
};

const isVisibleEvent = (event, now = new Date()) => {
  const expiry = eventExpiry(event);
  return Boolean(event && event.status !== "past" && expiry && expiry >= now);
};

const scoreEvent = (profile, event) => {
  if (!profile) return 0;
  const item = profile.itemAffinities || {};
  const finspo = profile.finspoAffinities || {};
  const shop = event.shopId && typeof event.shopId === "object" ? event.shopId : null;
  const organizer = event.organizerId && typeof event.organizerId === "object"
    ? event.organizerId
    : null;
  const promotionTags = normalizeHashtags(event.promotionTags);
  const shopLocation = [shop?.location?.city, shop?.location?.region]
    .filter(Boolean)
    .join(", ");
  return (
    affinityScore(item, "category", [event.type]) +
    affinityScore(item, "hashtags", promotionTags) +
    affinityScore(finspo, "hashtags", promotionTags) +
    affinityScore(item, "location", [
      event.location,
      shopLocation,
      shop?.location?.city,
      shop?.location?.region,
    ]) +
    affinityScore(item, "digishopId", [idValue(shop)]) +
    mapScore(finspo.creatorId, normalizeKey(idValue(organizer || event.organizerId)))
  );
};

const scoreExploreUser = (profile, user) => {
  if (!profile) return 0;
  const item = profile.itemAffinities || {};
  const finspo = profile.finspoAffinities || {};
  const location = [user.location?.city, user.location?.region].filter(Boolean).join(", ");
  return (
    mapScore(finspo.creatorId, normalizeKey(idValue(user))) +
    affinityScore(item, "digishopId", [idValue(user.shop)]) +
    affinityScore(item, "location", [location, user.location?.city, user.location?.region])
  );
};

const profileSignalCount = (profile) => {
  const counts = profile?.signalCounts;
  if (!counts) return 0;
  const entries = counts instanceof Map ? [...counts.values()] : Object.values(counts);
  return entries.reduce((total, value) => total + Math.max(Number(value) || 0, 0), 0);
};

const loadVisibleItems = async ({ ids, limit, ownShopId, snapshot }) => {
  if (ids && !ids.length) return [];
  const filter = {
    status: "active",
    visibility: { $ne: "event" },
    ...(ids?.length ? { _id: { $in: ids } } : {}),
    ...(snapshot ? { createdAt: { $lte: snapshot } } : {}),
    ...(ownShopId ? { shopId: { $ne: ownShopId } } : {}),
  };
  let query = Listing.find(filter)
    .select(
      "_id shopId location title description hashtags category brand size gender condition color type price currency quantity bulkMinQty bulkWeight volumeDiscounts images promotionTags promotionExpiresAt visibility status views createdAt updatedAt",
    )
    .sort({ createdAt: -1, _id: -1 });
  if (limit) query = query.limit(Math.min(limit * 2, EXPLORE_FEED.CANDIDATE_LIMIT * 2));
  const listings = await query.lean();
  const shops = await DigiShop.find({
    _id: { $in: listings.map((listing) => listing.shopId) },
    isLive: true,
  }).select("_id ownerId shopName slug bio logoUrl category location isLive rating totalReviews").lean();
  const owners = await User.find({
    _id: { $in: shops.map((shop) => shop.ownerId) },
    ...ACTIVE_ACCOUNT_FILTER,
  }).select("_id").lean();
  const shopMap = valuesById(shops);
  const ownerIds = new Set(owners.map(idValue));
  const visible = listings.flatMap((listing) => {
    const shop = shopMap.get(idValue(listing.shopId));
    return shop && ownerIds.has(idValue(shop.ownerId))
      ? [{ ...listing, shopId: safeShop(shop) }]
      : [];
  });
  return limit ? visible.slice(0, limit) : visible;
};

const loadVisibleFinspo = async ({ ids, limit, snapshot, userId }) => {
  if (ids && !ids.length) return [];
  const filter = {
    isArchived: { $ne: true },
    ...(ids?.length ? { _id: { $in: ids } } : {}),
    ...(snapshot ? { createdAt: { $lte: snapshot } } : {}),
    ...(userId ? { userId: { $ne: userId } } : {}),
  };
  let query = GalleryPost.find(filter)
    .select("_id userId imageUrl caption tags likes commentCount isArchived createdAt updatedAt")
    .sort({ createdAt: -1, _id: -1 });
  if (limit) query = query.limit(Math.min(limit * 2, EXPLORE_FEED.CANDIDATE_LIMIT * 2));
  const posts = await query.lean();
  const users = await User.find({
    _id: { $in: posts.map((post) => post.userId) },
    ...ACTIVE_ACCOUNT_FILTER,
  }).select("_id name username bio profilePhoto isKycVerified hasShop createdAt").lean();
  const userMap = valuesById(users);
  const visible = posts.flatMap((post) => {
    const user = userMap.get(idValue(post.userId));
    return user ? [{ ...post, userId: user }] : [];
  });
  return limit ? visible.slice(0, limit) : visible;
};

const loadVisibleEvents = async ({ ids, limit, ownShopId, snapshot, userId }) => {
  if (ids && !ids.length) return [];
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const filter = {
    status: { $ne: "past" },
    $or: [
      { endsAt: { $gte: now } },
      { endsAt: { $exists: false }, date: { $gte: todayStart } },
      { endsAt: null, date: { $gte: todayStart } },
    ],
    ...(ids?.length ? { _id: { $in: ids } } : {}),
    ...(snapshot ? { createdAt: { $lte: snapshot } } : {}),
    ...(userId ? { organizerId: { $ne: userId } } : {}),
    ...(ownShopId ? { shopId: { $ne: ownShopId } } : {}),
  };
  let query = Event.find(filter)
    .select(
      "_id organizerId shopId title description date location startTime endTime startsAt endsAt coverImage promotionTags promotionExpiresAt type status createdAt updatedAt",
    )
    .sort({ startsAt: 1, date: 1, _id: 1 });
  if (limit) query = query.limit(Math.min(limit * 2, EXPLORE_FEED.CANDIDATE_LIMIT * 2));
  const events = await query.lean();
  const [users, shops] = await Promise.all([
    User.find({
      _id: { $in: events.map((event) => event.organizerId) },
      ...ACTIVE_ACCOUNT_FILTER,
    }).select("_id name username profilePhoto isKycVerified hasShop").lean(),
    DigiShop.find({
      _id: { $in: events.map((event) => event.shopId).filter(Boolean) },
      isLive: true,
    }).select("_id ownerId shopName slug bio logoUrl category location isLive rating totalReviews").lean(),
  ]);
  const userMap = valuesById(users);
  const shopMap = valuesById(shops);
  const visible = events.flatMap((event) => {
    const organizer = userMap.get(idValue(event.organizerId));
    const shop = event.shopId ? shopMap.get(idValue(event.shopId)) : null;
    if (!organizer || !isVisibleEvent(event) || (event.shopId && !shop)) return [];
    return [{
      ...event,
      organizerId: organizer,
      ...(shop ? { shopId: safeShop(shop) } : { shopId: undefined }),
    }];
  });
  return limit ? visible.slice(0, limit) : visible;
};

const loadVisibleUsers = async ({ ids, limit, snapshot, userId }) => {
  if (ids && !ids.length) return [];
  const filter = {
    ...ACTIVE_ACCOUNT_FILTER,
    ...(ids?.length ? { _id: { $in: ids } } : {}),
    ...(snapshot ? { createdAt: { $lte: snapshot } } : {}),
    ...(userId ? { _id: { ...(ids?.length ? { $in: ids } : {}), $ne: userId } } : {}),
  };
  let query = User.find(filter)
    .select("_id name username bio profilePhoto location isKycVerified hasShop createdAt updatedAt")
    .sort({ createdAt: -1, _id: -1 });
  if (limit) query = query.limit(limit);
  const users = await query.lean();
  const shops = await DigiShop.find({
    ownerId: { $in: users.map((user) => user._id) },
    isLive: true,
  }).select("_id ownerId shopName slug bio logoUrl category location isLive rating totalReviews").lean();
  const shopsByOwner = new Map(shops.map((shop) => [idValue(shop.ownerId), shop]));
  return users.map((user) => ({
    ...user,
    shop: safeShop(shopsByOwner.get(idValue(user))) || null,
  }));
};

const loadExploreEntities = async ({ idsByType, limit, ownShopId, snapshot, userId }) => {
  const [items, finspo, events, users] = await Promise.all([
    loadVisibleItems({ ids: idsByType?.item, limit, ownShopId, snapshot }),
    loadVisibleFinspo({ ids: idsByType?.finspo, limit, snapshot, userId }),
    loadVisibleEvents({ ids: idsByType?.event, limit, ownShopId, snapshot, userId }),
    loadVisibleUsers({ ids: idsByType?.user, limit, snapshot, userId }),
  ]);
  return { item: items, finspo, event: events, user: users };
};

const exploreSeed = (value) => {
  const requested = String(value || "").normalize("NFKC").trim().slice(0, 120);
  return requested || crypto.randomBytes(12).toString("base64url");
};

const resolveExploreSession = ({ cursor, requestedSeed, userId }) => {
  const audience = idValue(userId) || "guest";
  if (!cursor) {
    return {
      audience,
      lastType: "",
      offset: 0,
      personalizedKeys: null,
      run: 0,
      seed: exploreSeed(requestedSeed),
      snapshot: new Date(),
    };
  }
  const session = decodeExploreCursor(cursor);
  if (session.audience !== audience) throw httpError(400, "Explore cursor belongs to another session");
  if (requestedSeed && String(requestedSeed).trim() !== session.seed) {
    throw httpError(400, "Explore seed does not match the cursor");
  }
  return session;
};

const isOwnExploreEntity = ({ entity, ownShopId, type, userId }) => {
  if (!userId && !ownShopId) return false;
  if (type === "item") return idValue(entity.shopId) === idValue(ownShopId);
  if (type === "finspo") return idValue(entity.userId) === idValue(userId);
  if (type === "event") {
    return idValue(entity.organizerId) === idValue(userId) || idValue(entity.shopId) === idValue(ownShopId);
  }
  return type === "user" && idValue(entity) === idValue(userId);
};

const buildCandidates = ({ entities, ownShopId, profile, userId }) => [
  ...entities.item.map((entity) => ({ entity, score: scoreListing(profile, entity), type: "item" })),
  ...entities.finspo.map((entity) => ({ entity, score: scoreFinspo(profile, entity), type: "finspo" })),
  ...entities.event.map((entity) => ({ entity, score: scoreEvent(profile, entity), type: "event" })),
  ...entities.user.map((entity) => ({ entity, score: scoreExploreUser(profile, entity), type: "user" })),
]
  .filter(({ entity, type }) => !isOwnExploreEntity({ entity, ownShopId, type, userId }))
  .map(({ entity, ...candidate }) => ({ ...candidate, id: idValue(entity) }));

const hydrateExploreEntries = async ({ entries, ownShopId, userId }) => {
  const idsByType = Object.fromEntries(TYPES.map((type) => [
    type,
    entries.filter((entry) => entry.type === type).map((entry) => entry.id),
  ]));
  const entities = await loadExploreEntities({ idsByType, ownShopId, userId });
  const maps = Object.fromEntries(TYPES.map((type) => [
    type,
    new Map(entities[type].map((entity) => [idValue(entity), entity])),
  ]));
  return new Map(entries.flatMap((entry) => {
    const entity = maps[entry.type].get(idValue(entry.id));
    return entity ? [[`${entry.type}:${entry.id}`, { entry, result: { type: entry.type, entity } }]] : [];
  }));
};

const buildExploreFeed = async ({ query = {}, userId }) => {
  const limit = Math.min(Math.max(Number(query.limit || EXPLORE_FEED.PAGE_SIZE), 1), EXPLORE_FEED.PAGE_SIZE);
  const session = resolveExploreSession({ cursor: query.cursor, requestedSeed: query.seed, userId });
  const ownShop = userId
    ? await DigiShop.findOne({ ownerId: userId }).select("_id").lean()
    : null;
  const ownShopId = ownShop?._id;
  const [profile, entities] = await Promise.all([
    userId ? ShadowProfile.findOne({ userId }).lean() : Promise.resolve(null),
    loadExploreEntities({
      limit: EXPLORE_FEED.CANDIDATE_LIMIT,
      ownShopId,
      snapshot: session.snapshot,
      userId,
    }),
  ]);
  const signalCount = profileSignalCount(profile);
  const eligible = Boolean(userId && signalCount >= EXPLORE_FEED.SIGNAL_THRESHOLD);
  const candidates = buildCandidates({ entities, ownShopId, profile, userId });
  const personalizedKeys = session.personalizedKeys || (eligible
    ? selectExplorePersonalizedKeys({ candidates, seed: session.seed })
    : []);
  const composed = composeExploreFeed({
    candidates,
    personalizedKeys,
    seed: session.seed,
  });
  let offset = session.offset;
  const selected = [];

  while (selected.length < limit && offset < composed.results.length) {
    const raw = composed.results.slice(offset, offset + limit);
    const hydrated = await hydrateExploreEntries({ entries: raw, ownShopId, userId });
    const needed = limit - selected.length;
    let consumed = 0;
    let visible = 0;
    for (const entry of raw) {
      consumed += 1;
      if (hydrated.has(`${entry.type}:${entry.id}`)) visible += 1;
      if (visible >= needed) break;
    }
    raw.slice(0, consumed).forEach((entry) => {
      const value = hydrated.get(`${entry.type}:${entry.id}`);
      if (value) selected.push(value);
    });
    offset += consumed;
    if (!raw.length || consumed === raw.length && raw.length < limit) break;
  }

  const orderedEntries = orderExploreBatch(
    selected.map(({ entry }) => entry),
    `${session.seed}:response:${session.offset}`,
    session,
  );
  const selectedByKey = new Map(selected.map((value) => [`${value.entry.type}:${value.entry.id}`, value]));
  const ordered = orderedEntries.map((entry) => selectedByKey.get(`${entry.type}:${entry.id}`));
  const allocations = {
    items: ordered.filter(({ entry }) => entry.type === "item").length,
    finspo: ordered.filter(({ entry }) => entry.type === "finspo").length,
    events: ordered.filter(({ entry }) => entry.type === "event").length,
    users: ordered.filter(({ entry }) => entry.type === "user").length,
  };
  const personalizedCount = ordered.filter(({ entry }) => entry.personalized).length;
  const hasMore = offset < composed.results.length;
  const diversityState = trailingDiversityState(orderedEntries, session);

  return {
    results: ordered.map(({ result }) => result),
    total: composed.results.length,
    hasMore,
    nextCursor: hasMore
      ? encodeExploreCursor({
          audience: session.audience,
          lastType: diversityState.lastType,
          offset,
          personalizedKeys,
          run: diversityState.run,
          seed: session.seed,
          snapshot: session.snapshot.toISOString(),
        })
      : null,
    feedSeed: session.seed,
    seed: session.seed,
    snapshot: session.snapshot.toISOString(),
    feed: {
      allocations,
      discoveryCount: ordered.length - personalizedCount,
      pageSize: EXPLORE_FEED.PAGE_SIZE,
      personalized: personalizedCount > 0,
      personalizedCount,
      quotas: { items: 20, finspo: 20, events: 5, users: 5 },
      signalCount,
      signalThreshold: EXPLORE_FEED.SIGNAL_THRESHOLD,
    },
  };
};

module.exports = {
  buildExploreFeed,
  eventExpiry,
  isVisibleEvent,
  isOwnExploreEntity,
  profileSignalCount,
  resolveExploreSession,
  scoreEvent,
  scoreExploreUser,
};
