const crypto = require("crypto");
const DigiShop = require("../models/DigiShop");
const Event = require("../models/Event");
const GalleryPost = require("../models/GalleryPost");
const Listing = require("../models/Listing");
const SearchDocument = require("../models/SearchDocument");
const User = require("../models/User");
const { normalizeHashtags } = require("../utils/hashtags");

const ACTIVE_ACCOUNT_FILTER = {
  $or: [{ accountStatus: "active" }, { accountStatus: { $exists: false } }],
};
const SOURCE_ALIASES = {
  event: "event",
  events: "event",
  finspo: "finspo",
  item: "item",
  items: "item",
  user: "user",
  users: "user",
};
const REBUILD_BATCH_SIZE = 250;

const idOf = (value) => value?._id || value;
const normalizeSearchText = (value) =>
  String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const compactStrings = (values) =>
  Array.from(new Set(values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    return [value];
  }).map(normalizeSearchText).filter(Boolean)));

const autocompleteTokensFor = (values) => {
  const tokens = new Set();
  compactStrings(values).forEach((value) => {
    const candidates = [value, ...value.split(/[^\p{L}\p{N}_-]+/gu)].filter(Boolean);
    candidates.forEach((candidate) => {
      const maximum = Math.min(candidate.length, 48);
      for (let length = 2; length <= maximum; length += 1) {
        tokens.add(candidate.slice(0, length));
      }
    });
  });
  return [...tokens];
};

const isActiveUser = (user) =>
  Boolean(user && (user.accountStatus === undefined || user.accountStatus === "active"));
const eventExpiresAt = (event) => {
  if (event?.endsAt) return new Date(event.endsAt);
  if (!event?.date) return null;
  const expiry = new Date(event.date);
  if (Number.isNaN(expiry.valueOf())) return null;
  expiry.setUTCHours(23, 59, 59, 999);
  return expiry;
};
const isActiveEvent = (event, now = new Date()) => {
  const expiry = eventExpiresAt(event);
  return Boolean(event && event.status !== "past" && expiry && expiry >= now);
};

const commonDocument = ({
  bodyText,
  expiresAt,
  hashtags,
  keywords,
  ownerId,
  primaryText,
  publishedAt,
  shop,
  sourceId,
  sourceType,
  sourceUpdatedAt,
  username,
}) => {
  const normalizedHashtags = normalizeHashtags(hashtags);
  const normalizedKeywords = compactStrings(keywords || []);
  const shopName = shop?.shopName || "";
  const values = [primaryText, username, shopName, normalizedHashtags, normalizedKeywords];

  return {
    sourceType,
    sourceId,
    ...(ownerId ? { ownerId } : {}),
    ...(shop?._id ? { shopId: shop._id } : {}),
    primaryText: String(primaryText || "").trim(),
    primaryNormalized: normalizeSearchText(primaryText),
    username: normalizeSearchText(username),
    shopName,
    shopNameNormalized: normalizeSearchText(shopName),
    keywords: normalizedKeywords,
    bodyText: String(bodyText || "").trim(),
    hashtags: normalizedHashtags,
    autocompleteTokens: autocompleteTokensFor(values),
    publishedAt: publishedAt || sourceUpdatedAt || new Date(),
    ...(expiresAt ? { expiresAt } : {}),
    sourceUpdatedAt: sourceUpdatedAt || new Date(),
  };
};

const mapListingSearchDocument = ({ listing, owner, shop }) => {
  if (
    !listing ||
    listing.status !== "active" ||
    listing.visibility === "event" ||
    !shop ||
    shop.isLive !== true ||
    !isActiveUser(owner)
  ) return null;

  return commonDocument({
    bodyText: listing.description,
    hashtags: listing.hashtags,
    keywords: [listing.brand, listing.category, listing.type],
    ownerId: owner._id,
    primaryText: listing.title,
    publishedAt: listing.createdAt,
    shop,
    sourceId: listing._id,
    sourceType: "item",
    sourceUpdatedAt: listing.updatedAt,
    username: owner.username,
  });
};

const mapFinspoSearchDocument = ({ owner, post }) => {
  if (!post || post.isArchived || !isActiveUser(owner)) return null;

  return commonDocument({
    bodyText: post.caption,
    hashtags: post.tags,
    keywords: [],
    ownerId: owner._id,
    primaryText: post.caption,
    publishedAt: post.createdAt,
    sourceId: post._id,
    sourceType: "finspo",
    sourceUpdatedAt: post.updatedAt,
    username: owner.username,
  });
};

const mapEventSearchDocument = ({ event, owner, shop }) => {
  if (
    !event ||
    !isActiveUser(owner) ||
    !isActiveEvent(event) ||
    (event.shopId && (!shop || shop.isLive !== true))
  ) return null;

  return commonDocument({
    bodyText: event.description,
    expiresAt: eventExpiresAt(event),
    hashtags: [],
    keywords: [event.type, event.location, owner.name],
    ownerId: owner._id,
    primaryText: event.title,
    publishedAt: event.startsAt || event.date || event.createdAt,
    shop,
    sourceId: event._id,
    sourceType: "event",
    sourceUpdatedAt: event.updatedAt,
    username: owner.username,
  });
};

const mapUserSearchDocument = ({ shop, user }) => {
  if (!isActiveUser(user)) return null;
  const liveShop = shop?.isLive === true ? shop : null;

  return commonDocument({
    bodyText: user.bio,
    hashtags: [],
    keywords: [user.location?.city, user.location?.region, liveShop?.bio, liveShop?.category],
    ownerId: user._id,
    primaryText: user.name,
    publishedAt: user.createdAt,
    shop: liveShop,
    sourceId: user._id,
    sourceType: "user",
    sourceUpdatedAt: user.updatedAt,
    username: user.username,
  });
};

const removeSearchDocument = async (sourceType, sourceId) => {
  const normalizedType = SOURCE_ALIASES[String(sourceType || "").toLowerCase()];
  if (!normalizedType || !sourceId) return { deletedCount: 0 };
  return SearchDocument.deleteOne({ sourceType: normalizedType, sourceId: idOf(sourceId) });
};

const upsertSearchDocument = async (document, options = {}) => {
  const update = { ...document };
  if (options.generation) update.rebuildGeneration = options.generation;
  const unset = {};
  ["expiresAt", "ownerId", "shopId"].forEach((field) => {
    if (!(field in document)) unset[field] = "";
  });
  await SearchDocument.updateOne(
    { sourceType: document.sourceType, sourceId: document.sourceId },
    { $set: update, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { runValidators: true, upsert: true },
  );
  return true;
};

const syncListingSearchDocument = async (listingOrId, options = {}) => {
  const sourceId = idOf(listingOrId);
  if (!sourceId) return false;
  const listing = await Listing.findById(sourceId).lean();
  const shop = listing
    ? await DigiShop.findOne({ _id: listing.shopId, isLive: true }).lean()
    : null;
  const owner = shop
    ? await User.findOne({ _id: shop.ownerId, ...ACTIVE_ACCOUNT_FILTER }).select("_id username accountStatus").lean()
    : null;
  const document = mapListingSearchDocument({ listing, owner, shop });
  if (!document) {
    await removeSearchDocument("item", sourceId);
    return false;
  }
  return upsertSearchDocument(document, options);
};

const syncFinspoSearchDocument = async (postOrId, options = {}) => {
  const sourceId = idOf(postOrId);
  if (!sourceId) return false;
  const post = await GalleryPost.findById(sourceId).lean();
  const owner = post
    ? await User.findOne({ _id: post.userId, ...ACTIVE_ACCOUNT_FILTER }).select("_id username accountStatus").lean()
    : null;
  const document = mapFinspoSearchDocument({ owner, post });
  if (!document) {
    await removeSearchDocument("finspo", sourceId);
    return false;
  }
  return upsertSearchDocument(document, options);
};

const syncEventSearchDocument = async (eventOrId, options = {}) => {
  const sourceId = idOf(eventOrId);
  if (!sourceId) return false;
  const event = await Event.findById(sourceId).lean();
  const owner = event
    ? await User.findOne({ _id: event.organizerId, ...ACTIVE_ACCOUNT_FILTER }).select("_id username name accountStatus").lean()
    : null;
  const shop = event?.shopId
    ? await DigiShop.findOne({ _id: event.shopId, isLive: true }).lean()
    : null;
  const document = mapEventSearchDocument({ event, owner, shop });
  if (!document) {
    await removeSearchDocument("event", sourceId);
    return false;
  }
  return upsertSearchDocument(document, options);
};

const syncUserSearchDocument = async (userOrId, options = {}) => {
  const sourceId = idOf(userOrId);
  if (!sourceId) return false;
  const user = await User.findById(sourceId)
    .select("_id name username bio profilePhoto location isKycVerified hasShop accountStatus createdAt updatedAt")
    .lean();
  if (!isActiveUser(user)) {
    await removeSearchDocument("user", sourceId);
    return false;
  }
  const shop = await DigiShop.findOne({ ownerId: user._id, isLive: true }).lean();
  return upsertSearchDocument(mapUserSearchDocument({ shop, user }), options);
};

const syncIds = async (Model, filter, sync, options) => {
  let indexed = 0;
  const cursor = Model.find(filter).select("_id").lean().cursor();
  for await (const document of cursor) {
    if (await sync(document._id, options)) indexed += 1;
  }
  return indexed;
};

const syncShopSearchDocuments = async (shopOrId, options = {}) => {
  const sourceId = idOf(shopOrId);
  if (!sourceId) return { events: 0, items: 0, user: 0 };
  const shop = await DigiShop.findById(sourceId).lean();
  if (!shop) {
    const linkedUsers = await SearchDocument.find({ sourceType: "user", shopId: sourceId })
      .select("ownerId")
      .lean();
    const ownerIds = distinctIds([
      shopOrId && typeof shopOrId === "object" ? shopOrId.ownerId : null,
      ...linkedUsers.map((document) => document.ownerId),
    ]);
    await SearchDocument.deleteMany({ shopId: sourceId });
    const users = await Promise.all(ownerIds.map((ownerId) => syncUserSearchDocument(ownerId, options)));
    return { events: 0, items: 0, user: users.filter(Boolean).length };
  }
  const [user, items, events] = await Promise.all([
    syncUserSearchDocument(shop.ownerId, options),
    syncIds(Listing, { shopId: shop._id }, syncListingSearchDocument, options),
    syncIds(Event, { shopId: shop._id }, syncEventSearchDocument, options),
  ]);
  return { events, items, user: Number(user) };
};

const removeUserSearchDocuments = async (userId) => {
  if (!userId) return { deletedCount: 0 };
  return SearchDocument.deleteMany({
    $or: [
      { sourceType: "user", sourceId: idOf(userId) },
      { ownerId: idOf(userId) },
    ],
  });
};

const rebuildUserSearchDocuments = async (userOrId, options = {}) => {
  const userId = idOf(userOrId);
  if (!userId) return { events: 0, finspo: 0, items: 0, user: 0 };
  const shop = await DigiShop.findOne({ ownerId: userId }).select("_id").lean();
  const [user, finspo, events, items] = await Promise.all([
    syncUserSearchDocument(userId, options),
    syncIds(GalleryPost, { userId }, syncFinspoSearchDocument, options),
    syncIds(Event, { organizerId: userId }, syncEventSearchDocument, options),
    shop ? syncIds(Listing, { shopId: shop._id }, syncListingSearchDocument, options) : 0,
  ]);
  return { events, finspo, items, user: Number(user) };
};

const runSearchSync = async (label, operation) => {
  const work = typeof label === "function" ? label : operation;
  const description = typeof label === "string" ? label : "search index";
  try {
    return await work();
  } catch (error) {
    console.warn(`${description} sync failed: ${error.message}`);
    return null;
  }
};

const valuesById = (values) =>
  new Map(values.map((value) => [String(value._id), value]));

const distinctIds = (values) =>
  Array.from(new Map(values.filter(Boolean).map((value) => [String(value), value])).values());

const bulkUpsertSearchDocuments = async (documents, generation) => {
  if (!documents.length) return 0;
  await SearchDocument.bulkWrite(
    documents.map((document) => {
      const unset = {};
      ["expiresAt", "ownerId", "shopId"].forEach((field) => {
        if (!(field in document)) unset[field] = "";
      });
      return {
        updateOne: {
          filter: { sourceType: document.sourceType, sourceId: document.sourceId },
          update: {
            $set: { ...document, rebuildGeneration: generation },
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
          },
          upsert: true,
        },
      };
    }),
    { ordered: false },
  );
  return documents.length;
};

const streamAndBulkIndex = async ({ generation, mapBatch, query }) => {
  let source = 0;
  let indexed = 0;
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const documents = await mapBatch(batch);
    indexed += await bulkUpsertSearchDocuments(documents, generation);
    batch = [];
  };

  const cursor = query.lean().cursor();
  for await (const document of cursor) {
    source += 1;
    batch.push(document);
    if (batch.length >= REBUILD_BATCH_SIZE) await flush();
  }
  await flush();
  return { indexed, source };
};

const mapListingBatch = async (listings) => {
  const shops = await DigiShop.find({
    _id: { $in: distinctIds(listings.map((listing) => listing.shopId)) },
    isLive: true,
  }).select("_id ownerId shopName isLive").lean();
  const owners = await User.find({
    _id: { $in: distinctIds(shops.map((shop) => shop.ownerId)) },
    ...ACTIVE_ACCOUNT_FILTER,
  }).select("_id username accountStatus").lean();
  const shopMap = valuesById(shops);
  const ownerMap = valuesById(owners);

  return listings.flatMap((listing) => {
    const shop = shopMap.get(String(listing.shopId));
    const document = mapListingSearchDocument({
      listing,
      owner: shop ? ownerMap.get(String(shop.ownerId)) : null,
      shop,
    });
    return document ? [document] : [];
  });
};

const mapFinspoBatch = async (posts) => {
  const owners = await User.find({
    _id: { $in: distinctIds(posts.map((post) => post.userId)) },
    ...ACTIVE_ACCOUNT_FILTER,
  }).select("_id username accountStatus").lean();
  const ownerMap = valuesById(owners);
  return posts.flatMap((post) => {
    const document = mapFinspoSearchDocument({
      owner: ownerMap.get(String(post.userId)),
      post,
    });
    return document ? [document] : [];
  });
};

const mapEventBatch = async (events) => {
  const [owners, shops] = await Promise.all([
    User.find({
      _id: { $in: distinctIds(events.map((event) => event.organizerId)) },
      ...ACTIVE_ACCOUNT_FILTER,
    }).select("_id username name accountStatus").lean(),
    DigiShop.find({
      _id: { $in: distinctIds(events.map((event) => event.shopId)) },
      isLive: true,
    }).select("_id ownerId shopName isLive").lean(),
  ]);
  const ownerMap = valuesById(owners);
  const shopMap = valuesById(shops);
  return events.flatMap((event) => {
    const document = mapEventSearchDocument({
      event,
      owner: ownerMap.get(String(event.organizerId)),
      shop: event.shopId ? shopMap.get(String(event.shopId)) : null,
    });
    return document ? [document] : [];
  });
};

const mapUserBatch = async (users) => {
  const shops = await DigiShop.find({
    ownerId: { $in: distinctIds(users.map((user) => user._id)) },
    isLive: true,
  }).select("_id ownerId shopName bio category isLive").lean();
  const shopsByOwner = new Map(shops.map((shop) => [String(shop.ownerId), shop]));
  return users.flatMap((user) => {
    const document = mapUserSearchDocument({
      shop: shopsByOwner.get(String(user._id)),
      user,
    });
    return document ? [document] : [];
  });
};

const rebuildSearchIndex = async () => {
  const startedAt = new Date();
  const generation = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
  await SearchDocument.createIndexes();
  const sources = [
    [
      "items",
      Listing.find({}).select(
        "_id shopId title description hashtags brand category type status visibility createdAt updatedAt",
      ),
      mapListingBatch,
    ],
    [
      "finspo",
      GalleryPost.find({}).select("_id userId caption tags isArchived createdAt updatedAt"),
      mapFinspoBatch,
    ],
    [
      "events",
      Event.find({}).select(
        "_id organizerId title description date location startsAt endsAt type shopId status createdAt updatedAt",
      ),
      mapEventBatch,
    ],
    [
      "users",
      User.find({}).select("_id name username bio location accountStatus createdAt updatedAt"),
      mapUserBatch,
    ],
  ];
  const counts = {};
  for (const [name, query, mapBatch] of sources) {
    counts[name] = await streamAndBulkIndex({ generation, mapBatch, query });
  }
  const pruned = await SearchDocument.deleteMany({
    rebuildGeneration: { $ne: generation },
    updatedAt: { $lte: startedAt },
  });
  return { counts, generation, pruned: pruned.deletedCount || 0, startedAt };
};

module.exports = {
  ACTIVE_ACCOUNT_FILTER,
  autocompleteTokensFor,
  eventExpiresAt,
  isActiveEvent,
  mapEventSearchDocument,
  mapFinspoSearchDocument,
  mapListingSearchDocument,
  mapUserSearchDocument,
  normalizeSearchText,
  rebuildSearchIndex,
  rebuildUserSearchDocuments,
  removeSearchDocument,
  removeUserSearchDocuments,
  runSearchSync,
  syncEventSearchDocument,
  syncFinspoSearchDocument,
  syncListingSearchDocument,
  syncShopSearchDocuments,
  syncUserSearchDocument,
};
