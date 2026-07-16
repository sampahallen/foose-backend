const Event = require("../models/Event");
const DigiShop = require("../models/DigiShop");
const GalleryPost = require("../models/GalleryPost");
const Listing = require("../models/Listing");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { withCache, invalidate, invalidatePattern } = require("../utils/cache");
const { RECOMMENDATION_SIGNALS } = require("../constants/recommendations");
const { awardFinspoSignal } = require("../services/recommendationService");
const { normalizeHashtags } = require("../utils/hashtags");
const { syncFinspoHashtags } = require("../services/hashtagService");

const pageOptions = (query) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

const promotionTags = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
};

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

  const result = await Event.updateMany(
    {
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
    },
    {
      $set: { status: "past", promotionTags: [] },
      $unset: { promotionExpiresAt: "" },
    },
  );

  if (result.modifiedCount) await invalidateEventCaches();
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
  if (req.body.promotionTags !== undefined) payload.promotionTags = promotionTags(req.body.promotionTags);
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
      promotionExpiresAt: { $gte: now },
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

  const updatedEvent = await Event.findById(event._id).populate(EVENT_MANAGE_POPULATE).lean();
  return success(res, { event: serializeEvent(updatedEvent) }, "Event updated");
});

exports.deleteEvent = asyncHandler(async (req, res) => {
  const event = await Event.findOneAndDelete({ _id: req.params.id, organizerId: req.user.id });

  if (!event) {
    throw httpError(404, "Event not found");
  }

  await invalidateEventCaches(event._id);

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
  const data = await withCache(`gallery:page:${page}`, 120, async () => {
    const [posts, total] = await Promise.all([
      GalleryPost.find()
        .populate("userId", "name username profilePhoto isKycVerified")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      GalleryPost.countDocuments(),
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

  return success(res, { post }, "Gallery post loaded");
});

exports.listMyGallery = asyncHandler(async (req, res) => {
  const posts = await GalleryPost.find({ userId: req.user.id })
    .populate("userId", "name username profilePhoto isKycVerified")
    .sort({ createdAt: -1 })
    .lean();

  return success(res, { posts, total: posts.length });
});

exports.listFollowingGallery = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select("following").lean();
  const following = user?.following || [];

  if (!following.length) {
    return success(res, { posts: [], total: 0 }, "Following gallery loaded");
  }

  const posts = await GalleryPost.find({ userId: { $in: following } })
    .populate("userId", "name username profilePhoto isKycVerified")
    .sort({ createdAt: -1 })
    .limit(60)
    .lean();

  return success(res, { posts, total: posts.length }, "Following gallery loaded");
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

  await invalidatePattern("gallery:page:*");

  return success(res, { post }, "Gallery post created", 201);
});

exports.updateGalleryPost = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne({ _id: req.params.id, userId: req.user.id });

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
  await invalidatePattern("gallery:page:*");

  return success(res, { post }, "Gallery post updated");
});

exports.deleteGalleryPost = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne({ _id: req.params.id, userId: req.user.id });

  if (!post) {
    throw httpError(404, "Gallery post not found");
  }

  await post.deleteOne();
  await syncFinspoHashtags(post, null);
  await invalidatePattern("gallery:page:*");

  return success(res, { post }, "Gallery post deleted");
});

exports.toggleLike = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findById(req.params.id);
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
  }

  return success(res, { post, liked: !hasLiked, likeCount: post.likes.length }, "Like updated");
});

exports.getLikeStatus = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findById(req.params.id).select("likes").lean();
  if (!post) throw httpError(404, "Gallery post not found");

  const liked = post.likes.some((id) => id.toString() === req.user.id);
  return success(res, { liked, likeCount: post.likes.length }, "Like status loaded");
});
