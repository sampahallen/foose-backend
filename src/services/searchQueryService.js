const crypto = require("crypto");
const mongoose = require("mongoose");
const DigiShop = require("../models/DigiShop");
const Event = require("../models/Event");
const GalleryPost = require("../models/GalleryPost");
const Listing = require("../models/Listing");
const SearchDocument = require("../models/SearchDocument");
const User = require("../models/User");
const httpError = require("../utils/httpError");
const { normalizeHashtag } = require("../utils/hashtags");
const { appendQueryClause } = require("../utils/location");
const { listingLocationClause } = require("./locationService");
const {
  ACTIVE_ACCOUNT_FILTER,
  isActiveEvent,
  normalizeSearchText,
} = require("./searchIndexService");

const SEARCH_SCOPES = ["all", "items", "finspo", "events", "users"];
const SCOPE_TYPES = {
  items: ["item"],
  finspo: ["finspo"],
  events: ["event"],
  users: ["user"],
  all: ["item", "finspo", "event", "user"],
};
const TYPE_SCOPE = { item: "items", finspo: "finspo", event: "events", user: "users" };
const CURSOR_SECRET =
  process.env.SEARCH_CURSOR_SECRET ||
  process.env.JWT_ACCESS_SECRET ||
  "foose-local-search-cursor";
const BROWSE_SUGGESTION_SCAN_LIMIT = 5000;
const BROWSE_SUGGESTION_LIMIT = 9;
const BROWSE_ITEM_SUGGESTION_LIMIT = 5;
const BROWSE_TERM_SUGGESTION_LIMIT = 4;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const objectMap = (values) => new Map(values.map((value) => [String(value._id), value]));
const textSearchExpression = (value) =>
  (normalizeSearchText(value).match(/[\p{L}\p{N}_-]+/gu) || [])
    .map((token) => token.replace(/^-+/, ""))
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, "")}"`)
    .join(" ");

const cursorFingerprint = ({ query, mode, scope }) =>
  crypto.createHash("sha256").update(`${mode}:${query}:${scope}`).digest("hex").slice(0, 20);

const shouldLogUnifiedSearch = ({ cursor, scope, track }) =>
  Boolean(track && !cursor && scope === "all");

const signCursorPayload = (payload) =>
  crypto.createHmac("sha256", CURSOR_SECRET).update(payload).digest("base64url");
const encodeCursor = (value) => {
  const payload = Buffer.from(JSON.stringify({ v: 2, ...value })).toString("base64url");
  return `${payload}.${signCursorPayload(payload)}`;
};
const decodeCursor = (cursor, fingerprint) => {
  if (!cursor) {
    return {
      after: null,
      counts: null,
      lastType: "",
      run: 0,
      scanned: 0,
      snapshotAt: new Date(),
    };
  }
  try {
    const [payload, signature, extra] = String(cursor).split(".");
    if (!payload || !signature || extra) throw new Error("invalid signature");
    const suppliedSignature = Buffer.from(signature, "base64url");
    const expectedSignature = Buffer.from(signCursorPayload(payload), "base64url");
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
    ) throw new Error("invalid signature");
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (value.v !== 2 || value.fingerprint !== fingerprint) throw new Error("mismatch");
    const run = Number(value.run);
    const scanned = Number(value.scanned);
    const snapshotAt = new Date(value.snapshotAt);
    const counts = value.counts;
    if (
      !Number.isSafeInteger(run) ||
      run < 0 ||
      !Number.isSafeInteger(scanned) ||
      scanned < 0 ||
      Number.isNaN(snapshotAt.valueOf()) ||
      !counts ||
      !["all", "items", "finspo", "events", "users"].every((key) =>
        Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    ) {
      throw new Error("invalid");
    }
    let after = null;
    if (value.after) {
      const publishedAt = new Date(value.after.publishedAt);
      const exactRank = Number(value.after.exactRank);
      const relevance = Number(value.after.relevance);
      if (
        !mongoose.isValidObjectId(value.after.id) ||
        Number.isNaN(publishedAt.valueOf()) ||
        !Number.isFinite(exactRank) ||
        !Number.isFinite(relevance)
      ) throw new Error("invalid position");
      after = {
        exactRank,
        id: String(value.after.id),
        publishedAt,
        relevance,
      };
    }
    return { after, counts, lastType: String(value.lastType || ""), run, scanned, snapshotAt };
  } catch {
    throw httpError(400, "Search cursor is invalid or no longer matches this query");
  }
};

const sortPosition = (row) => ({
  exactRank: Number(row.exactRank || 0),
  id: String(row._id),
  publishedAt: new Date(row.publishedAt),
  relevance: Number(row.relevance || 0),
});

const afterSortMatch = (after) => {
  if (!after) return {};
  const id = new mongoose.Types.ObjectId(after.id);
  return {
    $or: [
      { exactRank: { $lt: after.exactRank } },
      { exactRank: after.exactRank, relevance: { $lt: after.relevance } },
      {
        exactRank: after.exactRank,
        relevance: after.relevance,
        publishedAt: { $lt: after.publishedAt },
      },
      {
        _id: { $gt: id },
        exactRank: after.exactRank,
        publishedAt: after.publishedAt,
        relevance: after.relevance,
      },
    ],
  };
};

const sufficientlySimilar = (first, alternative) => {
  if (Number(first.exactRank || 0) !== Number(alternative.exactRank || 0)) return false;
  const score = Number(first.relevance || 1);
  return Number(alternative.relevance || 1) >= score * 0.85;
};

const diversifyRows = (rows, state = {}) => {
  const diversified = [...rows];
  let lastType = state.lastType || "";
  let run = Number(state.run || 0);

  for (let index = 0; index < diversified.length; index += 1) {
    let current = diversified[index];
    if (current.sourceType === lastType && run >= 2) {
      const alternativeIndex = diversified.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index &&
          candidate.sourceType !== lastType &&
          sufficientlySimilar(current, candidate),
      );
      if (alternativeIndex !== -1) {
        [diversified[index], diversified[alternativeIndex]] = [
          diversified[alternativeIndex],
          diversified[index],
        ];
        current = diversified[index];
      }
    }
    if (current.sourceType === lastType) run += 1;
    else {
      lastType = current.sourceType;
      run = 1;
    }
  }

  return { rows: diversified, lastType, run };
};

const visibilityMatch = (now = new Date()) => ({
  $or: [
    { sourceType: { $ne: "event" } },
    { expiresAt: { $gte: now } },
  ],
});

const exactRankExpression = (query) => ({
  $cond: [
    {
      $or: [
        { $eq: ["$primaryNormalized", query] },
        { $eq: ["$username", query.replace(/^@/, "")] },
        { $eq: ["$shopNameNormalized", query] },
        { $in: [/\s/u.test(query) ? "" : normalizeHashtag(query), "$hashtags"] },
      ],
    },
    1,
    0,
  ],
});

const aggregateSearchRows = async ({ after, limit, mode, query, scope, snapshotAt }) => {
  const isTag = mode === "tag";
  const firstMatch = isTag
    ? { hashtags: query, sourceType: { $in: ["item", "finspo"] } }
    : { $text: { $search: textSearchExpression(query), $caseSensitive: false, $diacriticSensitive: false } };
  const scoring = isTag
    ? { $set: { exactRank: 1, relevance: 1 } }
    : {
        $set: {
          exactRank: exactRankExpression(query),
          relevance: { $meta: "textScore" },
        },
      };
  const scopedTypes = SCOPE_TYPES[scope];

  const [facet = { counts: [], rows: [] }] = await SearchDocument.aggregate([
    { $match: firstMatch },
    { $match: { updatedAt: { $lte: snapshotAt } } },
    { $match: visibilityMatch() },
    scoring,
    { $sort: { exactRank: -1, relevance: -1, publishedAt: -1, _id: 1 } },
    {
      $facet: {
        counts: [{ $group: { _id: "$sourceType", count: { $sum: 1 } } }],
        rows: [
          { $match: { sourceType: { $in: scopedTypes } } },
          ...(after ? [{ $match: afterSortMatch(after) }] : []),
          { $limit: limit },
          {
            $project: {
              _id: 1,
              exactRank: 1,
              publishedAt: 1,
              relevance: 1,
              sourceId: 1,
              sourceType: 1,
            },
          },
        ],
      },
    },
  ]).allowDiskUse(true);

  const counts = { all: 0, items: 0, finspo: 0, events: 0, users: 0 };
  facet.counts.forEach(({ _id, count }) => {
    const countScope = TYPE_SCOPE[_id];
    if (!countScope) return;
    counts[countScope] = count;
    counts.all += count;
  });
  return { counts, rows: facet.rows || [] };
};

const safeShop = (shop) => shop && ({
  _id: shop._id,
  bio: shop.bio || "",
  category: shop.category,
  isLive: shop.isLive,
  location: shop.location,
  logoUrl: shop.logoUrl,
  rating: shop.rating || 0,
  shopName: shop.shopName,
  slug: shop.slug,
  totalReviews: shop.totalReviews || 0,
});

const hydrateItems = async (ids, listingFilter = {}) => {
  if (!ids.length) return new Map();
  const listings = await Listing.find({
    _id: { $in: ids },
    status: "active",
    visibility: { $ne: "event" },
    ...listingFilter,
  }).select(
    "_id shopId location title description hashtags category brand size gender condition color type price currency quantity bulkMinQty bulkWeight volumeDiscounts images promotionTags promotionExpiresAt visibility status views createdAt updatedAt",
  ).lean();
  const shops = await DigiShop.find({
    _id: { $in: listings.map((listing) => listing.shopId) },
    isLive: true,
  }).select("_id ownerId shopName slug bio logoUrl category location isLive rating totalReviews").lean();
  const shopMap = objectMap(shops);
  const owners = await User.find({
    _id: { $in: shops.map((shop) => shop.ownerId) },
    ...ACTIVE_ACCOUNT_FILTER,
  }).select("_id").lean();
  const ownerIds = new Set(owners.map((owner) => String(owner._id)));
  return new Map(listings.flatMap((listing) => {
    const shop = shopMap.get(String(listing.shopId));
    if (!shop || shop.isLive !== true || !ownerIds.has(String(shop.ownerId))) return [];
    return [[String(listing._id), { ...listing, shopId: safeShop(shop) }]];
  }));
};

const hydrateFinspo = async (ids) => {
  if (!ids.length) return new Map();
  const posts = await GalleryPost.find({ _id: { $in: ids }, isArchived: { $ne: true } })
    .select("_id userId imageUrl caption tags likes commentCount isArchived createdAt updatedAt")
    .lean();
  const users = await User.find({
    _id: { $in: posts.map((post) => post.userId) },
    ...ACTIVE_ACCOUNT_FILTER,
  }).select("_id name username bio profilePhoto isKycVerified hasShop createdAt").lean();
  const userMap = objectMap(users);
  return new Map(posts.flatMap((post) => {
    const user = userMap.get(String(post.userId));
    return user ? [[String(post._id), { ...post, userId: user }]] : [];
  }));
};

const hydrateEvents = async (ids) => {
  if (!ids.length) return new Map();
  const now = new Date();
  const events = await Event.find({ _id: { $in: ids }, status: { $ne: "past" } })
    .select(
      "_id organizerId shopId title description date location startTime endTime startsAt endsAt coverImage promotionTags promotionExpiresAt type status createdAt updatedAt",
    )
    .lean();
  const users = await User.find({
    _id: { $in: events.map((event) => event.organizerId) },
    ...ACTIVE_ACCOUNT_FILTER,
  }).select("_id name username profilePhoto isKycVerified hasShop").lean();
  const userMap = objectMap(users);
  const shops = await DigiShop.find({
    _id: { $in: events.map((event) => event.shopId).filter(Boolean) },
    isLive: true,
  }).select("_id ownerId shopName slug bio logoUrl category location isLive rating totalReviews").lean();
  const shopMap = objectMap(shops);
  return new Map(events.flatMap((event) => {
    const organizer = userMap.get(String(event.organizerId));
    const shop = event.shopId ? shopMap.get(String(event.shopId)) : null;
    if (!organizer || !isActiveEvent(event, now) || (event.shopId && !shop)) return [];
    return [[String(event._id), {
      ...event,
      organizerId: organizer,
      ...(shop ? { shopId: safeShop(shop) } : { shopId: undefined }),
    }]];
  }));
};

const hydrateUsers = async (ids) => {
  if (!ids.length) return new Map();
  const users = await User.find({ _id: { $in: ids }, ...ACTIVE_ACCOUNT_FILTER })
    .select("_id name username bio profilePhoto location isKycVerified hasShop createdAt updatedAt")
    .lean();
  const shops = await DigiShop.find({
    ownerId: { $in: users.map((user) => user._id) },
    isLive: true,
  }).select("_id ownerId shopName slug bio logoUrl category location isLive rating totalReviews").lean();
  const shopsByOwner = new Map(shops.map((shop) => [String(shop.ownerId), shop]));
  return new Map(users.map((user) => [String(user._id), {
    ...user,
    shop: safeShop(shopsByOwner.get(String(user._id))) || null,
  }]));
};

const hydrateSearchRows = async (rows) => {
  const ids = { item: [], finspo: [], event: [], user: [] };
  rows.forEach((row) => ids[row.sourceType]?.push(row.sourceId));
  const [items, finspo, events, users] = await Promise.all([
    hydrateItems(ids.item),
    hydrateFinspo(ids.finspo),
    hydrateEvents(ids.event),
    hydrateUsers(ids.user),
  ]);
  const maps = { item: items, finspo, event: events, user: users };
  return rows.flatMap((row) => {
    const entity = maps[row.sourceType]?.get(String(row.sourceId));
    return entity ? [{ type: row.sourceType, entity }] : [];
  });
};

const rowKey = (row) => `${row.sourceType}:${String(row.sourceId)}`;
const resultKey = (result) => `${result.type}:${String(result.entity._id)}`;
const visiblePrefixLength = (rows, visibleKeys, needed) => {
  let visible = 0;
  let consumed = 0;
  for (const row of rows) {
    consumed += 1;
    if (visibleKeys.has(rowKey(row))) visible += 1;
    if (visible >= needed) break;
  }
  return consumed;
};

const unifiedSearch = async ({ cursor, limit = 50, q, scope = "all", tag }) => {
  let mode = tag ? "tag" : "q";
  let query = tag ? normalizeHashtag(tag) : normalizeSearchText(q);
  if (!tag && String(q || "").trim().startsWith("#")) {
    mode = "tag";
    query = normalizeHashtag(q);
  }
  if (!query) throw httpError(422, mode === "tag" ? "A valid hashtag is required" : "A search query is required");
  if (mode === "q" && !textSearchExpression(query)) {
    throw httpError(422, "A search query must contain letters or numbers");
  }
  const fingerprint = cursorFingerprint({ mode, query, scope });
  const state = decodeCursor(cursor, fingerprint);
  let counts = state.counts || { all: 0, items: 0, finspo: 0, events: 0, users: 0 };
  let total = state.counts?.[scope] || 0;
  let after = state.after;
  let scanned = state.scanned;
  let diversityState = { lastType: state.lastType, run: state.run };
  let exhausted = false;
  const results = [];

  while (results.length < limit && !exhausted) {
    const page = await aggregateSearchRows({
      after,
      limit,
      mode,
      query,
      scope,
      snapshotAt: state.snapshotAt,
    });
    if (!state.counts) counts = page.counts;
    total = counts[scope];
    if (!page.rows.length) {
      exhausted = true;
      break;
    }

    const hydrated = await hydrateSearchRows(page.rows);
    const hydratedByKey = new Map(hydrated.map((result) => [resultKey(result), result]));
    const remaining = limit - results.length;
    const consumedCount = visiblePrefixLength(page.rows, new Set(hydratedByKey.keys()), remaining);

    const consumedRows = page.rows.slice(0, consumedCount);
    const consumedVisibleRows = consumedRows.filter((row) => hydratedByKey.has(rowKey(row)));
    const ordered = scope === "all"
      ? diversifyRows(consumedVisibleRows, diversityState)
      : {
          rows: consumedVisibleRows,
          lastType: consumedVisibleRows.at(-1)?.sourceType || diversityState.lastType,
          run: 0,
        };
    diversityState = { lastType: ordered.lastType, run: ordered.run };
    ordered.rows.forEach((row) => {
      const result = hydratedByKey.get(rowKey(row));
      if (result && results.length < limit) results.push(result);
    });
    if (consumedRows.length) after = sortPosition(consumedRows.at(-1));
    scanned += consumedCount;
    exhausted = consumedCount === page.rows.length && page.rows.length < limit;
    if (scanned >= total) exhausted = true;
  }

  const hasMore = !exhausted && scanned < total;
  return {
    counts,
    hasMore,
    nextCursor: hasMore
      ? encodeCursor({
          fingerprint,
          after,
          counts,
          lastType: diversityState.lastType,
          run: diversityState.run,
          scanned,
          snapshotAt: state.snapshotAt,
        })
      : null,
    query,
    results,
    scope,
    total,
  };
};

const entitySuggestion = ({ entity, type }) => {
  if (type === "item") return {
    entity,
    href: `/listing/${entity._id}`,
    id: `item:${entity._id}`,
    imageUrl: entity.images?.[0] || "",
    kind: "entity",
    label: entity.title,
    sourceId: entity._id,
    subtitle: typeof entity.shopId === "object" ? entity.shopId.shopName : "Item",
    type,
  };
  if (type === "finspo") {
    const user = typeof entity.userId === "object" ? entity.userId : null;
    return {
      entity,
      href: `/community/finspo/${entity._id}`,
      id: `finspo:${entity._id}`,
      imageUrl: entity.imageUrl,
      kind: "entity",
      label: entity.caption || `${user?.name || "Creator"}'s Finspo`,
      sourceId: entity._id,
      subtitle: user?.username ? `@${user.username}` : "Finspo",
      type,
      username: user?.username,
    };
  }
  if (type === "event") {
    const organizer = typeof entity.organizerId === "object" ? entity.organizerId : null;
    return {
      entity,
      href: `/community/events/${entity._id}`,
      id: `event:${entity._id}`,
      imageUrl: entity.coverImage || "",
      kind: "entity",
      label: entity.title,
      sourceId: entity._id,
      subtitle: entity.location || organizer?.name || "Event",
      type,
    };
  }
  return {
    entity,
    href: `/profile/${entity.username}`,
    id: `user:${entity._id}`,
    imageUrl: entity.profilePhoto || entity.shop?.logoUrl || "",
    kind: "entity",
    label: entity.name,
    sourceId: entity._id,
    subtitle: `@${entity.username}${entity.shop?.shopName ? ` - ${entity.shop.shopName}` : ""}`,
    type: "user",
    username: entity.username,
  };
};

const interleaveSuggestions = (entities, hashtags, limit) => {
  const suggestions = [];
  let entityIndex = 0;
  let hashtagIndex = 0;
  while (suggestions.length < limit && (entityIndex < entities.length || hashtagIndex < hashtags.length)) {
    if (entityIndex < entities.length) suggestions.push(entities[entityIndex++]);
    if (suggestions.length < limit && entityIndex < entities.length) suggestions.push(entities[entityIndex++]);
    if (suggestions.length < limit && hashtagIndex < hashtags.length) suggestions.push(hashtags[hashtagIndex++]);
  }
  return suggestions;
};

const visibleHashtagRows = async (prefix, limit = 5) => {
  if (!prefix) return [];
  const pattern = new RegExp(`^${escapeRegex(prefix)}`);
  const candidates = await SearchDocument.aggregate([
    { $match: { hashtags: pattern, sourceType: { $in: ["item", "finspo"] } } },
    { $unwind: "$hashtags" },
    { $match: { hashtags: pattern } },
    { $group: { _id: "$hashtags", indexedCount: { $sum: 1 } } },
    { $sort: { indexedCount: -1, _id: 1 } },
    { $limit: 100 },
  ]);
  const visible = [];

  for (let offset = 0; offset < candidates.length && visible.length < limit; offset += 20) {
    const names = candidates.slice(offset, offset + 20).map((candidate) => candidate._id);
    const documents = await SearchDocument.find({
      hashtags: { $in: names },
      sourceType: { $in: ["item", "finspo"] },
    })
      .limit(1000)
      .select("sourceType sourceId hashtags")
      .lean();
    const hydrated = await hydrateSearchRows(documents);
    const visibleKeys = new Set(hydrated.map(resultKey));
    const counts = new Map();
    documents.forEach((document) => {
      if (!visibleKeys.has(rowKey(document))) return;
      document.hashtags.forEach((tag) => {
        if (names.includes(tag)) counts.set(tag, (counts.get(tag) || 0) + 1);
      });
    });
    candidates.slice(offset, offset + 20).forEach((candidate) => {
      const count = counts.get(candidate._id) || 0;
      if (count) visible.push({ _id: candidate._id, count });
    });
  }

  return visible
    .sort((first, second) => second.count - first.count || first._id.localeCompare(second._id))
    .slice(0, limit);
};

const visibleEntitySuggestionDocuments = async (prefix, target = 36) => {
  if (!prefix) return [];
  const visible = [];
  let offset = 0;

  while (visible.length < target && offset < 5000) {
    const documents = await SearchDocument.find({
      autocompleteTokens: prefix,
      ...visibilityMatch(),
    })
      .sort({ publishedAt: -1, _id: 1 })
      .skip(offset)
      .limit(50)
      .select("sourceType sourceId primaryNormalized username shopNameNormalized publishedAt")
      .lean();
    if (!documents.length) break;
    const hydrated = await hydrateSearchRows(documents);
    const visibleKeys = new Set(hydrated.map(resultKey));
    documents.forEach((document) => {
      if (visibleKeys.has(rowKey(document)) && visible.length < target) visible.push(document);
    });
    offset += documents.length;
    if (documents.length < 50) break;
  }

  return visible;
};

const normalizedWordStartsWith = (value, prefix) => {
  const normalized = normalizeSearchText(value);
  if (!normalized || !prefix) return false;
  return normalized.startsWith(prefix) || normalized
    .split(/[^\p{L}\p{N}_-]+/gu)
    .some((word) => word.startsWith(prefix));
};

const browseDocumentMatchesPrefix = (document, prefix) => [
  document.primaryNormalized,
  ...(document.keywords || []),
  ...(document.hashtags || []),
].some((value) => normalizedWordStartsWith(value, prefix));

const buildBrowseListingFilter = async ({
  brand,
  category,
  color,
  condition,
  gender,
  location,
  maxPrice,
  minPrice,
  size,
  type,
} = {}) => {
  const filter = {};
  Object.entries({ brand, category, color, condition, gender, size, type }).forEach(([field, value]) => {
    if (value !== undefined && value !== "") filter[field] = value;
  });
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.price = {};
    if (minPrice !== undefined) filter.price.$gte = Number(minPrice);
    if (maxPrice !== undefined) filter.price.$lte = Number(maxPrice);
  }
  if (location) {
    appendQueryClause(filter, await listingLocationClause(location));
  }
  return filter;
};

const browseSuggestionRank = (document, prefix) => {
  const values = [document.primaryNormalized, ...(document.keywords || []), ...(document.hashtags || [])]
    .map(normalizeSearchText)
    .filter(Boolean);
  if (values.includes(prefix)) return 2;
  return values.some((value) => normalizedWordStartsWith(value, prefix)) ? 1 : 0;
};

const termSuggestionsFor = (entities, prefix) => {
  const terms = new Map();
  const add = (type, rawValue) => {
    const value = type === "hashtag" ? normalizeHashtag(rawValue) : String(rawValue || "").trim();
    const normalized = normalizeSearchText(value);
    if (!value || !normalizedWordStartsWith(normalized, prefix)) return;
    const key = `${type}:${normalized}`;
    const current = terms.get(key);
    if (current) {
      current.count += 1;
      return;
    }
    terms.set(key, {
      count: 1,
      kind: "term",
      label: type === "hashtag" ? `#${value}` : value,
      type,
      value,
    });
  };

  entities.forEach((entity) => {
    add("brand", entity.brand);
    add("category", entity.category);
    new Set((entity.hashtags || []).map(normalizeHashtag).filter(Boolean))
      .forEach((hashtag) => add("hashtag", hashtag));
  });

  const typeRank = { brand: 0, category: 1, hashtag: 2 };
  return [...terms.values()].sort((first, second) =>
    Number(normalizeSearchText(second.value) === prefix) - Number(normalizeSearchText(first.value) === prefix) ||
    second.count - first.count ||
    typeRank[first.type] - typeRank[second.type] ||
    first.label.localeCompare(second.label));
};

const browseSuggestions = async ({ limit = BROWSE_SUGGESTION_LIMIT, q, ...filters }) => {
  const query = normalizeSearchText(q).replace(/^#+/, "");
  if (query.length < 2) return { suggestions: [] };
  const requestedLimit = Math.min(
    Math.max(Number(limit) || BROWSE_SUGGESTION_LIMIT, 1),
    BROWSE_SUGGESTION_LIMIT,
  );
  const documents = await SearchDocument.find({
    autocompleteTokens: query,
    sourceType: "item",
  })
    .sort({ publishedAt: -1, _id: 1 })
    .limit(BROWSE_SUGGESTION_SCAN_LIMIT)
    .select("sourceType sourceId primaryNormalized keywords hashtags publishedAt")
    .lean();
  const searchableDocuments = documents.filter((document) => browseDocumentMatchesPrefix(document, query));
  const listingFilter = await buildBrowseListingFilter(filters);
  const itemMap = await hydrateItems(searchableDocuments.map((document) => document.sourceId), listingFilter);
  const visibleDocuments = searchableDocuments
    .filter((document) => itemMap.has(String(document.sourceId)))
    .map((document) => ({ ...document, browseRank: browseSuggestionRank(document, query) }))
    .sort((first, second) =>
      second.browseRank - first.browseRank ||
      new Date(second.publishedAt) - new Date(first.publishedAt) ||
      String(first.sourceId).localeCompare(String(second.sourceId)));
  const visibleEntities = visibleDocuments.map((document) => itemMap.get(String(document.sourceId)));
  const termSuggestions = termSuggestionsFor(visibleEntities, query)
    .slice(0, Math.min(BROWSE_TERM_SUGGESTION_LIMIT, requestedLimit));
  const itemSuggestions = visibleEntities
    .slice(0, Math.min(BROWSE_ITEM_SUGGESTION_LIMIT, requestedLimit - termSuggestions.length))
    .map((entity) => entitySuggestion({ entity, type: "item" }));

  return { suggestions: [...termSuggestions, ...itemSuggestions] };
};

const unifiedSuggestions = async ({ q, limit = 10, scope, ...filters }) => {
  if (scope === "items") return browseSuggestions({ q, limit, ...filters });
  const query = normalizeSearchText(q);
  if (query.length < 2) return { suggestions: [] };
  const tagPrefix = normalizeHashtag(query);
  const entityPrefix = query.replace(/^@/, "");
  const [documents, hashtagRows] = await Promise.all([
    visibleEntitySuggestionDocuments(entityPrefix, 36),
    visibleHashtagRows(tagPrefix, 5),
  ]);
  const ranked = documents.map((document) => ({
    ...document,
    exactRank: [document.primaryNormalized, document.username, document.shopNameNormalized].includes(entityPrefix) ? 1 : 0,
    relevance: [document.primaryNormalized, document.username, document.shopNameNormalized]
      .filter(Boolean).some((value) => value.startsWith(entityPrefix)) ? 2 : 1,
  })).sort((first, second) =>
    second.exactRank - first.exactRank ||
    second.relevance - first.relevance ||
    new Date(second.publishedAt) - new Date(first.publishedAt) ||
    String(first.sourceId).localeCompare(String(second.sourceId)));
  const diversified = diversifyRows(ranked).rows;
  const hydrated = await hydrateSearchRows(diversified);
  const entitySuggestions = hydrated.map(entitySuggestion);
  const hashtagSuggestions = hashtagRows.map((row) => ({
    hashtag: `#${row._id}`,
    href: `/search?tag=${encodeURIComponent(row._id)}&tab=all`,
    id: `hashtag:${row._id}`,
    kind: "hashtag",
    label: `#${row._id}`,
    subtitle: "Hashtag",
    type: "hashtag",
  }));
  return { suggestions: interleaveSuggestions(entitySuggestions, hashtagSuggestions, limit) };
};

module.exports = {
  SEARCH_SCOPES,
  afterSortMatch,
  browseDocumentMatchesPrefix,
  browseSuggestions,
  buildBrowseListingFilter,
  decodeCursor,
  diversifyRows,
  encodeCursor,
  hydrateSearchRows,
  shouldLogUnifiedSearch,
  sortPosition,
  unifiedSearch,
  unifiedSuggestions,
  visibleEntitySuggestionDocuments,
  visibleHashtagRows,
  visiblePrefixLength,
  textSearchExpression,
  termSuggestionsFor,
};
