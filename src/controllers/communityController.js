const Event = require("../models/Event");
const DigiShop = require("../models/DigiShop");
const FinspoComment = require("../models/FinspoComment");
const GalleryPost = require("../models/GalleryPost");
const Listing = require("../models/Listing");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { withCache, invalidate, invalidatePattern } = require("../utils/cache");
const { RECOMMENDATION_SIGNALS } = require("../constants/recommendations");
const {
  awardFinspoSignal,
  buildFinspoAccountSuggestions,
} = require("../services/recommendationService");
const { normalizeHashtags } = require("../utils/hashtags");
const { syncFinspoHashtags } = require("../services/hashtagService");
const {
  notifyFinspoComment,
  notifyFinspoCommentLike,
  notifyFinspoPostLike,
  notifyFinspoReply,
} = require("../services/finspoNotificationService");
const {
  runSearchSync,
  syncEventSearchDocument,
  syncFinspoSearchDocument,
} = require("../services/searchIndexService");
const {
  FINSPO_ARCHIVE_RETENTION_DAYS,
  expiredArchivedFinspoFilter,
  finspoArchiveExpiresAt,
  finspoArchiveTimestamp,
  finspoRestoreSnapshots,
  isArchivedFinspoExpired,
  unexpiredArchivedFinspoFilter,
} = require("../utils/finspoLifecycle");

const ACTIVE_ACCOUNT_FILTER = {
  $or: [{ accountStatus: "active" }, { accountStatus: { $exists: false } }],
};

const pageOptions = (query) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

const FINSPO_COMMENT_POPULATE = [
  { path: "userId", select: "name username profilePhoto isKycVerified" },
  { path: "replyToUserId", select: "name username profilePhoto isKycVerified" },
];

const serializeFinspoComment = (comment, viewerId) => {
  const value = typeof comment?.toObject === "function" ? comment.toObject() : comment;
  const likes = Array.isArray(value?.likes) ? value.likes : [];

  return {
    _id: value._id,
    postId: value.postId,
    body: value.body,
    userId: value.userId || null,
    rootCommentId: value.rootCommentId || null,
    replyToCommentId: value.replyToCommentId || null,
    replyToUserId: value.replyToUserId || null,
    liked: Boolean(viewerId && likes.some((id) => id.toString() === viewerId)),
    likeCount: likes.length,
    replyCount: Number(value.replyCount) || 0,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

const activeGalleryPostFilter = (postId) => ({
  _id: postId,
  isArchived: { $ne: true },
});

const finspoActor = (req) => req.currentUser;

const BASE_EVENT_POPULATE = [
  { path: "organizerId", select: "name username profilePhoto hasShop" },
  { path: "shopId", select: "shopName slug logoUrl ownerId" },
];

const EVENT_PUBLIC_POPULATE = [
  ...BASE_EVENT_POPULATE,
  {
    path: "eventListings",
    match: { status: "active" },
    populate: { path: "shopId", select: "shopName slug rating totalReviews ownerId" },
  },
];

const EVENT_MANAGE_POPULATE = [
  ...BASE_EVENT_POPULATE,
  {
    path: "eventListings",
    match: { status: { $ne: "removed" } },
    populate: { path: "shopId", select: "shopName slug rating totalReviews ownerId" },
  },
];

const normalizeEventType = (type) => {
  if (type === "online") return "online-pop-up";
  if (type === "pop-up" || type === "fair") return "in-person-pop-up";
  return type;
};

const isOnlinePopUp = (type) => normalizeEventType(type) === "online-pop-up";

const normalizeTime = (value) => {
  const text = String(value || "").trim();
  const match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return "";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
};

const datePart = (value) => {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value || "").trim();
  const directMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) return directMatch[1];

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().slice(0, 10);
  return "";
};

const dateWithTime = (dateValue, timeValue, fallbackTime) => {
  const day = datePart(dateValue);
  const time = normalizeTime(timeValue || fallbackTime);
  if (!day || !time) return null;

  const value = new Date(`${day}T${time}:00.000Z`);
  return Number.isNaN(value.valueOf()) ? null : value;
};

const eventStatus = (event, now = new Date()) => {
  const startsAt = event.startsAt ? new Date(event.startsAt) : dateWithTime(event.date, event.startTime, "00:00");
  const endsAt = event.endsAt ? new Date(event.endsAt) : dateWithTime(event.date, event.endTime, "23:59");

  if (endsAt && endsAt < now) return "past";
  if (startsAt && startsAt <= now) return "ongoing";
  return "upcoming";
};

const serializeEvent = (event) => {
  if (!event) return event;
  return {
    ...event,
    type: normalizeEventType(event.type),
    status: eventStatus(event),
  };
};

const upcomingEventFilter = () => {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  return {
    status: { $ne: "past" },
    $or: [
      { endsAt: { $gte: now } },
      { endsAt: { $exists: false }, date: { $gte: todayStart } },
      { endsAt: null, date: { $gte: todayStart } },
    ],
  };
};

const revokePastEventPromotions = async () => {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  const expiringFilter = {
    $and: [
      {
        $or: [
          { endsAt: { $lt: now } },
          { endsAt: { $exists: false }, date: { $lt: todayStart } },
          { endsAt: null, date: { $lt: todayStart } },
        ],
      },
      {
        $or: [
          { status: { $ne: "past" } },
          { promotionTags: { $exists: true, $ne: [] } },
          { promotionExpiresAt: { $exists: true, $ne: null } },
        ],
      },
    ],
  };
  const expiringEvents = await Event.find(expiringFilter).select("_id").lean();
  const result = await Event.updateMany(
    expiringFilter,
    {
      $set: { status: "past", promotionTags: [] },
      $unset: { promotionExpiresAt: "" },
    },
  );

  if (result.modifiedCount) {
    await Promise.all([
      invalidateEventCaches(),
      ...expiringEvents.map((event) =>
        runSearchSync(`event:${event._id}:expire`, () =>
          syncEventSearchDocument(event._id))),
    ]);
  }
};

const invalidateEventCaches = async (...eventIds) => {
  await Promise.all([
    invalidate("events:feed", "events:upcoming", "events:featured", ...eventIds.map((id) => `event:${id}`)),
    invalidatePattern("events:feed:*"),
  ]);
};

const buildEventTiming = ({ date, endTime, startTime, type }) => {
  const normalizedType = normalizeEventType(type);
  const normalizedStartTime = normalizeTime(startTime);
  const normalizedEndTime = normalizeTime(endTime);

  if (!datePart(date)) throw httpError(422, "Event date is required");
  if (!normalizedStartTime) throw httpError(422, "Event start time is required");
  if (isOnlinePopUp(normalizedType) && !normalizedEndTime) {
    throw httpError(422, "Online pop-ups require an ending time");
  }

  const eventDate = dateWithTime(date, "00:00", "00:00");
  const startsAt = dateWithTime(date, normalizedStartTime, "00:00");
  const endsAt = isOnlinePopUp(normalizedType)
    ? dateWithTime(date, normalizedEndTime, "23:59")
    : dateWithTime(date, normalizedEndTime || "23:59", "23:59");

  if (!eventDate || !startsAt || !endsAt) throw httpError(422, "Event date or time is invalid");
  if (isOnlinePopUp(normalizedType) && endsAt <= startsAt) {
    throw httpError(422, "Online pop-up ending time must be after the start time");
  }

  return {
    date: eventDate,
    endTime: normalizedEndTime,
    endsAt,
    startTime: normalizedStartTime,
    startsAt,
  };
};

const eventInput = async (req, currentEvent) => {
  const nextType = normalizeEventType(req.body.type || currentEvent?.type);
  if (!["online-pop-up", "in-person-pop-up"].includes(nextType)) {
    throw httpError(422, "Choose online pop-up or in-person pop-up");
  }

  const nextDate = req.body.date !== undefined ? req.body.date : currentEvent?.date;
  const nextStartTime =
    req.body.startTime !== undefined ? req.body.startTime : currentEvent?.startTime || (currentEvent ? "00:00" : "");
  const nextEndTime =
    req.body.endTime !== undefined
      ? req.body.endTime
      : currentEvent?.endTime || (currentEvent && nextType === "online-pop-up" ? "23:59" : "");
  const nextLocation = req.body.location !== undefined ? String(req.body.location || "").trim() : currentEvent?.location;

  if (nextType === "in-person-pop-up" && !nextLocation) {
    throw httpError(422, "In-person pop-ups require a location");
  }

  const payload = {
    type: nextType,
    ...buildEventTiming({
      date: nextDate,
      endTime: nextEndTime,
      startTime: nextStartTime,
      type: nextType,
    }),
    location: nextType === "online-pop-up" ? "" : nextLocation,
    status: "upcoming",
  };

  ["title", "description"].forEach((field) => {
    if (req.body[field] !== undefined) payload[field] = req.body[field];
  });
  if (req.fileUrls?.[0]) payload.coverImage = req.fileUrls[0];

  if (nextType === "online-pop-up") {
    const shop = await DigiShop.findOne({ ownerId: req.user.id }).select("_id");
    if (!shop) throw httpError(403, "A DigiShop is required to host an online pop-up");
    payload.shopId = shop._id;
  } else {
    payload.shopId = undefined;
    if (!currentEvent) payload.eventListings = [];
  }

  payload.status = eventStatus(payload);
  return payload;
};

const ownedManageEventQuery = (eventId, userId) =>
  Event.findOne({ _id: eventId, organizerId: userId }).populate(EVENT_MANAGE_POPULATE);

exports.listEvents = asyncHandler(async (req, res) => {
  await revokePastEventPromotions();
  const { page, limit, skip } = pageOptions(req.query);
  const data = await withCache(`events:feed:${page}:${limit}`, 120, async () => {
    const filter = upcomingEventFilter();
    const [events, total] = await Promise.all([
      Event.find(filter)
        .populate(EVENT_PUBLIC_POPULATE)
        .sort({ startsAt: 1, date: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Event.countDocuments(filter),
    ]);

    return { events: events.map(serializeEvent), total, page, pages: Math.ceil(total / limit) };
  });

  return success(res, data, "Events loaded");
});

exports.listFeaturedEvents = asyncHandler(async (req, res) => {
  await revokePastEventPromotions();
  const now = new Date();
  const events = await withCache("events:featured", 120, () =>
    Event.find({
      ...upcomingEventFilter(),
      promotionTags: { $in: ["featured", "home-featured", "home-banner"] },
      promotionExpiresAt: { $gt: now },
    })
      .populate(EVENT_PUBLIC_POPULATE)
      .sort({ startsAt: 1, date: 1, createdAt: -1 })
      .limit(8)
      .lean(),
  );

  return success(res, { events: events.map(serializeEvent) }, "Featured events loaded");
});

exports.getEvent = asyncHandler(async (req, res) => {
  await revokePastEventPromotions();
  const event = await withCache(`event:${req.params.id}`, 120, () =>
    Event.findById(req.params.id).populate(EVENT_PUBLIC_POPULATE).lean(),
  );
  if (!event) throw httpError(404, "Event not found");

  return success(res, { event: serializeEvent(event) }, "Event loaded");
});

exports.listMyEvents = asyncHandler(async (req, res) => {
  await revokePastEventPromotions();
  const events = await Event.find({ organizerId: req.user.id })
    .populate(EVENT_MANAGE_POPULATE)
    .sort({ startsAt: -1, date: -1, createdAt: -1 })
    .lean();

  return success(res, { events: events.map(serializeEvent) }, "Your events loaded");
});

exports.createEvent = asyncHandler(async (req, res) => {
  const event = await Event.create({
    organizerId: req.user.id,
    title: req.body.title,
    description: req.body.description || "",
    ...(await eventInput(req)),
  });

  await invalidateEventCaches(event._id);
  await runSearchSync(`event:${event._id}:create`, () =>
    syncEventSearchDocument(event._id));

  const createdEvent = await Event.findById(event._id).populate(EVENT_MANAGE_POPULATE).lean();
  return success(res, { event: serializeEvent(createdEvent) }, "Event created", 201);
});

exports.updateEvent = asyncHandler(async (req, res) => {
  const event = await Event.findOne({ _id: req.params.id, organizerId: req.user.id });

  if (!event) {
    throw httpError(404, "Event not found");
  }

  const input = await eventInput(req, event);
  Object.assign(event, input);
  if (input.type === "in-person-pop-up") {
    event.shopId = undefined;
    event.eventListings = [];
  }

  await event.save();
  await invalidateEventCaches(event._id);
  await runSearchSync(`event:${event._id}:update`, () =>
    syncEventSearchDocument(event._id));

  const updatedEvent = await Event.findById(event._id).populate(EVENT_MANAGE_POPULATE).lean();
  return success(res, { event: serializeEvent(updatedEvent) }, "Event updated");
});

exports.deleteEvent = asyncHandler(async (req, res) => {
  const event = await Event.findOneAndDelete({ _id: req.params.id, organizerId: req.user.id });

  if (!event) {
    throw httpError(404, "Event not found");
  }

  await invalidateEventCaches(event._id);
  await runSearchSync(`event:${event._id}:delete`, () =>
    syncEventSearchDocument(event._id));

  return success(res, { event }, "Event deleted");
});

exports.getManagedEvent = asyncHandler(async (req, res) => {
  const event = await ownedManageEventQuery(req.params.id, req.user.id).lean();
  if (!event) throw httpError(404, "Event not found");

  return success(res, { event: serializeEvent(event) }, "Event management loaded");
});

exports.addEventListing = asyncHandler(async (req, res) => {
  const event = await ownedManageEventQuery(req.params.id, req.user.id);
  if (!event) throw httpError(404, "Event not found");
  if (!isOnlinePopUp(event.type)) throw httpError(422, "Only online pop-ups can host listings");

  const shop = await DigiShop.findOne({ ownerId: req.user.id }).select("_id");
  if (!shop) throw httpError(403, "A DigiShop is required to manage online pop-up listings");

  const listing = await Listing.findOne({
    _id: req.body.listingId,
    shopId: shop._id,
    status: { $ne: "removed" },
  }).select("_id");

  if (!listing) throw httpError(404, "Listing not found in your catalog");

  event.eventListings.addToSet(listing._id);
  await event.save();
  await invalidateEventCaches(event._id);

  const updatedEvent = await Event.findById(event._id).populate(EVENT_MANAGE_POPULATE).lean();
  return success(res, { event: serializeEvent(updatedEvent) }, "Listing added to pop-up");
});

exports.removeEventListing = asyncHandler(async (req, res) => {
  const event = await ownedManageEventQuery(req.params.id, req.user.id);
  if (!event) throw httpError(404, "Event not found");
  if (!isOnlinePopUp(event.type)) throw httpError(422, "Only online pop-ups can host listings");

  event.eventListings = event.eventListings.filter((listing) => listing._id.toString() !== req.params.listingId);
  await event.save();
  await invalidateEventCaches(event._id);

  const updatedEvent = await Event.findById(event._id).populate(EVENT_MANAGE_POPULATE).lean();
  return success(res, { event: serializeEvent(updatedEvent) }, "Listing removed from pop-up");
});

exports.toggleAttend = asyncHandler(async (req, res) => {
  const event = await Event.findById(req.params.id);
  if (!event) throw httpError(404, "Event not found");

  const userId = req.user.id;
  const hasAttended = event.attendees.some((id) => id.toString() === userId);

  if (hasAttended) {
    event.attendees = event.attendees.filter((id) => id.toString() !== userId);
  } else {
    event.attendees.push(userId);
  }

  await event.save();
  await invalidateEventCaches(event._id);

  return success(res, { event: serializeEvent(event.toObject()), attending: !hasAttended }, "RSVP updated");
});

exports.listGallery = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req.query);
  const data = await withCache(`gallery:page:${page}:limit:${limit}`, 120, async () => {
    const [posts, total] = await Promise.all([
      GalleryPost.find({ isArchived: { $ne: true } })
        .populate("userId", "name username profilePhoto isKycVerified")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      GalleryPost.countDocuments({ isArchived: { $ne: true } }),
    ]);

    return { posts, total, page, pages: Math.ceil(total / limit) };
  });

  return success(res, data);
});

exports.getGalleryPost = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findById(req.params.id)
    .populate("userId", "name username profilePhoto isKycVerified")
    .lean();

  if (!post) throw httpError(404, "Gallery post not found");
  if (isArchivedFinspoExpired(post)) {
    const deletedPost = await GalleryPost.findOneAndDelete({
      _id: post._id,
      ...expiredArchivedFinspoFilter(),
    });
    if (deletedPost) await FinspoComment.deleteMany({ postId: post._id });
    if (deletedPost) {
      await runSearchSync(`finspo:${post._id}:expire`, () =>
        syncFinspoSearchDocument(post._id));
    }
    throw httpError(404, "Gallery post not found");
  }
  const ownerId = post.userId && typeof post.userId === "object" ? post.userId._id : post.userId;
  if (post.isArchived && String(ownerId || "") !== String(req.user?.id || "")) {
    throw httpError(404, "Gallery post not found");
  }

  const serializedPost = post.isArchived
    ? {
        ...post,
        archiveDeleteAt: finspoArchiveExpiresAt(post),
        archivedAt: finspoArchiveTimestamp(post),
      }
    : post;

  return success(res, { post: serializedPost }, "Gallery post loaded");
});

exports.listMyGallery = asyncHandler(async (req, res) => {
  const posts = await GalleryPost.find({
    isArchived: { $ne: true },
    userId: req.user.id,
  })
    .populate("userId", "name username profilePhoto isKycVerified")
    .sort({ createdAt: -1 })
    .lean();

  return success(res, { posts, total: posts.length });
});

exports.listMyArchivedGallery = asyncHandler(async (req, res) => {
  const posts = await GalleryPost.find({
    ...unexpiredArchivedFinspoFilter(),
    userId: req.user.id,
  })
    .populate("userId", "name username profilePhoto isKycVerified")
    .sort({ archivedAt: -1, updatedAt: -1 })
    .lean();
  const serializedPosts = posts.map((post) => ({
    ...post,
    archiveDeleteAt: finspoArchiveExpiresAt(post),
    archivedAt: finspoArchiveTimestamp(post),
  }));

  return success(
    res,
    {
      posts: serializedPosts,
      retentionDays: FINSPO_ARCHIVE_RETENTION_DAYS,
      total: serializedPosts.length,
    },
    "Archived Finspo loaded",
  );
});

exports.listFollowingGallery = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select("following").lean();
  const following = user?.following || [];
  const activeFollowing = following.length
    ? await User.distinct("_id", {
        ...ACTIVE_ACCOUNT_FILTER,
        _id: { $in: following, $ne: req.user.id },
      })
    : [];

  if (!activeFollowing.length) {
    const { suggestedAccounts, suggestionMeta } = await buildFinspoAccountSuggestions({
      excludedUserIds: following,
      userId: req.user.id,
    });

    return success(
      res,
      {
        followingCount: 0,
        posts: [],
        suggestedAccounts,
        suggestionMeta,
        total: 0,
      },
      "Following gallery loaded",
    );
  }

  const posts = await GalleryPost.find({
    isArchived: { $ne: true },
    userId: { $in: activeFollowing },
  })
    .populate("userId", "name username profilePhoto isKycVerified")
    .sort({ createdAt: -1 })
    .limit(60)
    .lean();

  return success(
    res,
    {
      followingCount: activeFollowing.length,
      posts,
      suggestedAccounts: [],
      suggestionMeta: null,
      total: posts.length,
    },
    "Following gallery loaded",
  );
});

exports.listFinspoComments = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne(activeGalleryPostFilter(req.params.id))
    .select("_id commentCount")
    .lean();
  if (!post) throw httpError(404, "Gallery post not found");

  const { page, limit, skip } = pageOptions(req.query);
  const filter = { postId: post._id, rootCommentId: null };
  const [comments, total] = await Promise.all([
    FinspoComment.find(filter)
      .populate(FINSPO_COMMENT_POPULATE)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    FinspoComment.countDocuments(filter),
  ]);

  return success(
    res,
    {
      comments: comments.map((comment) => serializeFinspoComment(comment, req.user?.id)),
      total,
      totalComments: Number(post.commentCount) || 0,
      page,
      pages: Math.ceil(total / limit),
    },
    "Finspo comments loaded",
  );
});

exports.listFinspoCommentReplies = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne(activeGalleryPostFilter(req.params.id))
    .select("_id commentCount")
    .lean();
  if (!post) throw httpError(404, "Gallery post not found");

  const target = await FinspoComment.findOne({
    _id: req.params.commentId,
    postId: post._id,
  })
    .select("_id rootCommentId")
    .lean();
  if (!target) throw httpError(404, "Finspo comment not found");

  const rootCommentId = target.rootCommentId || target._id;
  if (target.rootCommentId) {
    const rootExists = await FinspoComment.exists({
      _id: rootCommentId,
      postId: post._id,
      rootCommentId: null,
    });
    if (!rootExists) throw httpError(404, "Finspo comment thread not found");
  }

  const { page, limit, skip } = pageOptions(req.query);
  const filter = { postId: post._id, rootCommentId };
  const [replies, total] = await Promise.all([
    FinspoComment.find(filter)
      .populate(FINSPO_COMMENT_POPULATE)
      .sort({ createdAt: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    FinspoComment.countDocuments(filter),
  ]);

  return success(
    res,
    {
      replies: replies.map((reply) => serializeFinspoComment(reply, req.user?.id)),
      rootCommentId,
      rootReplyCount: total,
      total,
      totalComments: Number(post.commentCount) || 0,
      page,
      pages: Math.ceil(total / limit),
    },
    "Finspo comment replies loaded",
  );
});

exports.getFinspoCommentContext = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne(activeGalleryPostFilter(req.params.id))
    .select("_id commentCount")
    .lean();
  if (!post) throw httpError(404, "Gallery post not found");

  const target = await FinspoComment.findOne({
    _id: req.params.commentId,
    postId: post._id,
  })
    .populate(FINSPO_COMMENT_POPULATE)
    .lean();
  if (!target) throw httpError(404, "Finspo comment not found");

  const rootCommentId = target.rootCommentId || target._id;
  let rootComment = target;
  if (target.rootCommentId) {
    rootComment = await FinspoComment.findOne({
      _id: rootCommentId,
      postId: post._id,
      rootCommentId: null,
    })
      .populate(FINSPO_COMMENT_POPULATE)
      .lean();
    if (!rootComment) throw httpError(404, "Finspo comment thread not found");
  }

  return success(
    res,
    {
      isReply: Boolean(target.rootCommentId),
      rootComment: serializeFinspoComment(rootComment, req.user?.id),
      rootCommentId,
      target: serializeFinspoComment(target, req.user?.id),
      totalComments: Number(post.commentCount) || 0,
    },
    "Finspo comment context loaded",
  );
});

exports.createFinspoComment = asyncHandler(async (req, res) => {
  const filter = activeGalleryPostFilter(req.params.id);
  const post = await GalleryPost.findOne(filter).select("_id userId").lean();
  if (!post) throw httpError(404, "Gallery post not found");

  const comment = await FinspoComment.create({
    postId: post._id,
    userId: req.user.id,
    body: req.body.body,
  });

  let countedPost;
  try {
    countedPost = await GalleryPost.findOneAndUpdate(
      filter,
      { $inc: { commentCount: 1 } },
      { new: true, runValidators: true },
    ).select("_id commentCount");
  } catch (error) {
    await FinspoComment.deleteOne({ _id: comment._id });
    throw error;
  }

  if (!countedPost) {
    await FinspoComment.deleteOne({ _id: comment._id });
    throw httpError(404, "Gallery post not found");
  }

  await comment.populate(FINSPO_COMMENT_POPULATE);
  await invalidatePattern("gallery:page:*");

  void notifyFinspoComment({
    actor: finspoActor(req),
    comment,
    postId: post._id,
    recipientId: post.userId,
  });

  return success(
    res,
    {
      comment: serializeFinspoComment(comment, req.user.id),
      totalComments: Number(countedPost.commentCount) || 0,
    },
    "Finspo comment created",
    201,
  );
});

exports.createFinspoCommentReply = asyncHandler(async (req, res) => {
  const postFilter = activeGalleryPostFilter(req.params.id);
  const post = await GalleryPost.findOne(postFilter).select("_id").lean();
  if (!post) throw httpError(404, "Gallery post not found");

  const target = await FinspoComment.findOne({
    _id: req.params.commentId,
    postId: post._id,
  }).select("_id rootCommentId userId");
  if (!target) throw httpError(404, "Finspo comment not found");

  const rootCommentId = target.rootCommentId || target._id;
  const root = await FinspoComment.findOne({
    _id: rootCommentId,
    postId: post._id,
    rootCommentId: null,
  }).select("_id");
  if (!root) throw httpError(404, "Finspo comment thread not found");

  const reply = await FinspoComment.create({
    postId: post._id,
    userId: req.user.id,
    body: req.body.body,
    rootCommentId: root._id,
    replyToCommentId: target._id,
    replyToUserId: target.userId,
  });

  let countedPost;
  try {
    countedPost = await GalleryPost.findOneAndUpdate(
      postFilter,
      { $inc: { commentCount: 1 } },
      { new: true, runValidators: true },
    ).select("_id commentCount");
  } catch (error) {
    await FinspoComment.deleteOne({ _id: reply._id });
    throw error;
  }

  if (!countedPost) {
    await FinspoComment.deleteOne({ _id: reply._id });
    throw httpError(404, "Gallery post not found");
  }

  let countedRoot;
  try {
    countedRoot = await FinspoComment.findOneAndUpdate(
      { _id: root._id, postId: post._id, rootCommentId: null },
      { $inc: { replyCount: 1 } },
      { new: true, runValidators: true },
    ).select("_id replyCount");
  } catch (error) {
    await Promise.all([
      FinspoComment.deleteOne({ _id: reply._id }),
      GalleryPost.updateOne(
        { _id: post._id, commentCount: { $gt: 0 } },
        { $inc: { commentCount: -1 } },
      ),
    ]);
    throw error;
  }

  if (!countedRoot) {
    await Promise.all([
      FinspoComment.deleteOne({ _id: reply._id }),
      GalleryPost.updateOne(
        { _id: post._id, commentCount: { $gt: 0 } },
        { $inc: { commentCount: -1 } },
      ),
    ]);
    throw httpError(404, "Finspo comment thread not found");
  }

  if (target._id.toString() !== root._id.toString()) {
    let countedTarget;
    try {
      countedTarget = await FinspoComment.findOneAndUpdate(
        { _id: target._id, postId: post._id },
        { $inc: { replyCount: 1 } },
        { new: true, runValidators: true },
      ).select("_id");
    } catch (error) {
      await Promise.all([
        FinspoComment.deleteOne({ _id: reply._id }),
        GalleryPost.updateOne(
          { _id: post._id, commentCount: { $gt: 0 } },
          { $inc: { commentCount: -1 } },
        ),
        FinspoComment.updateOne(
          { _id: root._id, replyCount: { $gt: 0 } },
          { $inc: { replyCount: -1 } },
        ),
      ]);
      throw error;
    }

    if (!countedTarget) {
      await Promise.all([
        FinspoComment.deleteOne({ _id: reply._id }),
        GalleryPost.updateOne(
          { _id: post._id, commentCount: { $gt: 0 } },
          { $inc: { commentCount: -1 } },
        ),
        FinspoComment.updateOne(
          { _id: root._id, replyCount: { $gt: 0 } },
          { $inc: { replyCount: -1 } },
        ),
      ]);
      throw httpError(404, "Reply target not found");
    }
  }

  await reply.populate(FINSPO_COMMENT_POPULATE);
  await invalidatePattern("gallery:page:*");

  void notifyFinspoReply({
    actor: finspoActor(req),
    postId: post._id,
    recipientId: target.userId,
    reply,
  });

  return success(
    res,
    {
      reply: serializeFinspoComment(reply, req.user.id),
      rootCommentId: root._id,
      rootReplyCount: Number(countedRoot.replyCount) || 0,
      totalComments: Number(countedPost.commentCount) || 0,
    },
    "Finspo reply created",
    201,
  );
});

exports.toggleFinspoCommentLike = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne(activeGalleryPostFilter(req.params.id))
    .select("_id")
    .lean();
  if (!post) throw httpError(404, "Gallery post not found");

  const comment = await FinspoComment.findOne({
    _id: req.params.commentId,
    postId: post._id,
  });
  if (!comment) throw httpError(404, "Finspo comment not found");

  const userId = req.user.id;
  const hasLiked = comment.likes.some((id) => id.toString() === userId);
  if (hasLiked) {
    comment.likes = comment.likes.filter((id) => id.toString() !== userId);
  } else {
    comment.likes.push(userId);
  }
  await comment.save();
  if (!hasLiked) {
    void notifyFinspoCommentLike({
      actor: finspoActor(req),
      comment,
      postId: post._id,
      recipientId: comment.userId,
    });
  }
  return success(
    res,
    {
      commentId: comment._id,
      liked: !hasLiked,
      likeCount: comment.likes.length,
    },
    "Finspo comment like updated",
  );
});

exports.createGalleryPost = asyncHandler(async (req, res) => {
  const imageUrl = req.fileUrls?.[0];
  if (!imageUrl) throw httpError(422, "Gallery image is required");

  const tags = normalizeHashtags(req.body.tags);

  const post = await GalleryPost.create({
    userId: req.user.id,
    imageUrl,
    caption: req.body.caption,
    tags,
  });

  await syncFinspoHashtags(null, post);
  await runSearchSync(`finspo:${post._id}:create`, () =>
    syncFinspoSearchDocument(post._id));

  await invalidatePattern("gallery:page:*");

  return success(res, { post }, "Gallery post created", 201);
});

exports.updateGalleryPost = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne({
    _id: req.params.id,
    userId: req.user.id,
    isArchived: { $ne: true },
  });

  if (!post) {
    throw httpError(404, "Gallery post not found");
  }

  const previousPost = post.toObject();
  if (req.body.caption !== undefined) post.caption = req.body.caption;
  if (req.body.tags !== undefined) {
    post.tags = normalizeHashtags(req.body.tags);
  }
  if (req.fileUrls?.[0]) post.imageUrl = req.fileUrls[0];

  await post.save();
  await syncFinspoHashtags(previousPost, post);
  await runSearchSync(`finspo:${post._id}:update`, () =>
    syncFinspoSearchDocument(post._id));
  await invalidatePattern("gallery:page:*");

  return success(res, { post }, "Gallery post updated");
});

exports.deleteGalleryPost = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOneAndDelete({
    _id: req.params.id,
    userId: req.user.id,
  });

  if (!post) {
    throw httpError(404, "Gallery post not found");
  }

  await FinspoComment.deleteMany({ postId: post._id });
  await syncFinspoHashtags(post, null);
  await runSearchSync(`finspo:${post._id}:delete`, () =>
    syncFinspoSearchDocument(post._id));
  await invalidatePattern("gallery:page:*");

  return success(res, { post }, "Gallery post deleted");
});

exports.archiveGalleryPost = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne({ _id: req.params.id, userId: req.user.id });
  if (!post) throw httpError(404, "Gallery post not found");

  if (isArchivedFinspoExpired(post)) {
    const deletedPost = await GalleryPost.findOneAndDelete({
      _id: post._id,
      ...expiredArchivedFinspoFilter(),
    });
    if (deletedPost) await FinspoComment.deleteMany({ postId: post._id });
    if (deletedPost) {
      await runSearchSync(`finspo:${post._id}:expire`, () =>
        syncFinspoSearchDocument(post._id));
    }
    throw httpError(404, "Gallery post not found");
  }

  if (!post.isArchived) {
    const previousPost = post.toObject();
    const archivedAt = new Date();
    post.isArchived = true;
    post.archivedAt = archivedAt;
    post.archiveDeleteAt = finspoArchiveExpiresAt({ archivedAt });
    await post.save();
    await syncFinspoHashtags(previousPost, post);
    await runSearchSync(`finspo:${post._id}:archive`, () =>
      syncFinspoSearchDocument(post._id));
    await invalidatePattern("gallery:page:*");
  } else if (!post.archiveDeleteAt) {
    const archivedAt = finspoArchiveTimestamp(post);
    post.archivedAt = archivedAt;
    post.archiveDeleteAt = finspoArchiveExpiresAt(post);
    await post.save();
  }

  await FinspoComment.updateMany(
    { postId: post._id },
    { $set: { postDeleteAt: post.archiveDeleteAt } },
  );

  return success(res, { post }, "Gallery post archived");
});

exports.restoreGalleryPost = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOneAndUpdate(
    {
      _id: req.params.id,
      userId: req.user.id,
      ...unexpiredArchivedFinspoFilter(),
    },
    {
      $set: { isArchived: false },
      $unset: { archiveDeleteAt: "", archivedAt: "" },
    },
    { new: true, runValidators: true },
  );
  if (!post) throw httpError(404, "Archived gallery post not found");

  await FinspoComment.updateMany(
    { postId: post._id },
    { $unset: { postDeleteAt: "" } },
  );

  const { after, before } = finspoRestoreSnapshots(post);
  await syncFinspoHashtags(before, after);
  await runSearchSync(`finspo:${post._id}:restore`, () =>
    syncFinspoSearchDocument(post._id));
  await invalidatePattern("gallery:page:*");
  await post.populate("userId", "name username profilePhoto isKycVerified");

  return success(res, { post }, "Gallery post restored");
});

exports.toggleLike = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne({ _id: req.params.id, isArchived: { $ne: true } });
  if (!post) throw httpError(404, "Gallery post not found");

  const userId = req.user.id;
  const hasLiked = post.likes.some((id) => id.toString() === userId);

  if (hasLiked) {
    post.likes = post.likes.filter((id) => id.toString() !== userId);
  } else {
    post.likes.push(userId);
  }

  await post.save();
  await invalidatePattern("gallery:page:*");

  if (!hasLiked) {
    await awardFinspoSignal(
      req.user.id,
      post._id,
      RECOMMENDATION_SIGNALS.FINSPO_LIKE,
    ).catch((error) => {
      console.warn(`Finspo recommendation signal failed: ${error.message}`);
    });
    void notifyFinspoPostLike({
      actor: finspoActor(req),
      postId: post._id,
      recipientId: post.userId,
    });
  }

  return success(res, { post, liked: !hasLiked, likeCount: post.likes.length }, "Like updated");
});

exports.getLikeStatus = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne({ _id: req.params.id, isArchived: { $ne: true } })
    .select("likes")
    .lean();
  if (!post) throw httpError(404, "Gallery post not found");

  const liked = post.likes.some((id) => id.toString() === req.user.id);
  return success(res, { liked, likeCount: post.likes.length }, "Like status loaded");
});
