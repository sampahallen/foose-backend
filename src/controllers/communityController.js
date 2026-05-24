const Event = require("../models/Event");
const GalleryPost = require("../models/GalleryPost");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { withCache, invalidate, invalidatePattern } = require("../utils/cache");

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

exports.listEvents = asyncHandler(async (req, res) => {
  const events = await withCache("events:feed", 120, () =>
    Event.find()
      .sort({ date: -1, createdAt: -1 })
      .lean(),
  );

  return success(res, { events }, "Events loaded");
});

exports.listFeaturedEvents = asyncHandler(async (req, res) => {
  const events = await withCache("events:featured", 120, () =>
    Event.find({
      promotionTags: { $in: ["featured", "home-featured", "home-banner"] },
      status: { $ne: "past" },
    })
      .sort({ date: 1, createdAt: -1 })
      .limit(8)
      .lean(),
  );

  return success(res, { events }, "Featured events loaded");
});

exports.getEvent = asyncHandler(async (req, res) => {
  const event = await Event.findById(req.params.id).lean();
  if (!event) throw httpError(404, "Event not found");

  return success(res, { event }, "Event loaded");
});

exports.listMyEvents = asyncHandler(async (req, res) => {
  const events = await Event.find({ organizerId: req.user.id })
    .sort({ date: -1, createdAt: -1 })
    .lean();

  return success(res, { events }, "Your events loaded");
});

exports.createEvent = asyncHandler(async (req, res) => {
  const event = await Event.create({
    organizerId: req.user.id,
    title: req.body.title,
    description: req.body.description,
    date: req.body.date,
    location: req.body.location,
    type: req.body.type,
    status: req.body.status || "upcoming",
    coverImage: req.fileUrls?.[0],
    promotionTags: promotionTags(req.body.promotionTags),
  });

  await invalidate("events:feed", "events:upcoming", "events:featured");

  return success(res, { event }, "Event created", 201);
});

exports.updateEvent = asyncHandler(async (req, res) => {
  const event = await Event.findOne({ _id: req.params.id, organizerId: req.user.id });

  if (!event) {
    throw httpError(404, "Event not found");
  }

  ["title", "description", "date", "location", "type", "status"].forEach((field) => {
    if (req.body[field] !== undefined) event[field] = req.body[field];
  });
  if (req.body.promotionTags !== undefined) event.promotionTags = promotionTags(req.body.promotionTags);

  if (req.fileUrls?.[0]) event.coverImage = req.fileUrls[0];

  await event.save();
  await invalidate("events:feed", "events:upcoming", "events:featured");

  return success(res, { event }, "Event updated");
});

exports.deleteEvent = asyncHandler(async (req, res) => {
  const event = await Event.findOneAndDelete({ _id: req.params.id, organizerId: req.user.id });

  if (!event) {
    throw httpError(404, "Event not found");
  }

  await invalidate("events:feed", "events:upcoming", "events:featured");

  return success(res, { event }, "Event deleted");
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
  await invalidate("events:feed", "events:upcoming", "events:featured");

  return success(res, { event, attending: !hasAttended }, "RSVP updated");
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

  const tags =
    typeof req.body.tags === "string"
      ? req.body.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : req.body.tags || [];

  const post = await GalleryPost.create({
    userId: req.user.id,
    imageUrl,
    caption: req.body.caption,
    tags,
  });

  await invalidatePattern("gallery:page:*");

  return success(res, { post }, "Gallery post created", 201);
});

exports.updateGalleryPost = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOne({ _id: req.params.id, userId: req.user.id });

  if (!post) {
    throw httpError(404, "Gallery post not found");
  }

  if (req.body.caption !== undefined) post.caption = req.body.caption;
  if (req.body.tags !== undefined) {
    post.tags =
      typeof req.body.tags === "string"
        ? req.body.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : req.body.tags;
  }
  if (req.fileUrls?.[0]) post.imageUrl = req.fileUrls[0];

  await post.save();
  await invalidatePattern("gallery:page:*");

  return success(res, { post }, "Gallery post updated");
});

exports.deleteGalleryPost = asyncHandler(async (req, res) => {
  const post = await GalleryPost.findOneAndDelete({ _id: req.params.id, userId: req.user.id });

  if (!post) {
    throw httpError(404, "Gallery post not found");
  }

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

  return success(res, { post, liked: !hasLiked }, "Like updated");
});
