const Event = require("../models/Event");
const GalleryPost = require("../models/GalleryPost");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");

const pageOptions = (query) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

exports.listEvents = asyncHandler(async (req, res) => {
  const events = await Event.find().sort({ date: 1 });
  return success(res, { events }, "Events loaded");
});

exports.createEvent = asyncHandler(async (req, res) => {
  const event = await Event.create({
    organizerId: req.user.id,
    title: req.body.title,
    description: req.body.description,
    date: req.body.date,
    location: req.body.location,
    type: req.body.type,
    coverImage: req.fileUrls?.[0] || req.body.coverImage,
  });

  return success(res, { event }, "Event created", 201);
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

  return success(res, { event, attending: !hasAttended }, "RSVP updated");
});

exports.listGallery = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageOptions(req.query);
  const [posts, total] = await Promise.all([
    GalleryPost.find()
      .populate("userId", "name username profilePhoto isKycVerified")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    GalleryPost.countDocuments(),
  ]);

  return success(res, { posts, total, page, pages: Math.ceil(total / limit) });
});

exports.createGalleryPost = asyncHandler(async (req, res) => {
  const imageUrl = req.fileUrls?.[0] || req.body.imageUrl;
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

  return success(res, { post }, "Gallery post created", 201);
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

  return success(res, { post, liked: !hasLiked }, "Like updated");
});
