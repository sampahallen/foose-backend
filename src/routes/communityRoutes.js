const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/communityController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");
const { singleImage } = require("../middleware/uploadMiddleware");

const router = express.Router();

const eventTypes = ["online-pop-up", "in-person-pop-up", "online", "pop-up", "fair"];

const eventBody = z.object({
  title: z.string().min(2).optional(),
  description: z.string().max(60).optional(),
  date: z.string().min(1).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  location: z.string().optional(),
  type: z.enum(eventTypes).optional(),
  status: z.enum(["upcoming", "ongoing", "past"]).optional(),
  promotionTags: z.any().optional(),
}).strict();

const galleryBody = z.object({
  caption: z.string().optional(),
  tags: z.any().optional(),
}).strict();

router.get("/events", controller.listEvents);
router.get("/events/me", auth, controller.listMyEvents);
router.get("/events/featured", controller.listFeaturedEvents);
router.get("/events/:id/manage", auth, controller.getManagedEvent);
router.post(
  "/events/:id/listings",
  auth,
  validate(
    z.object({
      body: z.object({ listingId: z.string().min(1) }).strict(),
      params: z.object({ id: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.addEventListing,
);
router.delete(
  "/events/:id/listings/:listingId",
  auth,
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({ id: z.string().min(1), listingId: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.removeEventListing,
);
router.get("/events/:id", controller.getEvent);
router.post(
  "/events",
  auth,
  ...singleImage("events", "coverImage"),
  validate(
    z.object({
      body: eventBody.extend({
        title: z.string().min(2),
        date: z.string().min(1),
        startTime: z.string().min(1),
        type: z.enum(eventTypes),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createEvent,
);
router.put(
  "/events/:id",
  auth,
  ...singleImage("events", "coverImage"),
  validate(
    z.object({
      body: eventBody,
      params: z.object({ id: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.updateEvent,
);
router.delete("/events/:id", auth, controller.deleteEvent);
router.post("/events/:id/attend", auth, controller.toggleAttend);
router.get("/gallery", controller.listGallery);
router.get("/gallery/me", auth, controller.listMyGallery);
router.get("/gallery/following", auth, controller.listFollowingGallery);
router.get("/gallery/:id/like", auth, controller.getLikeStatus);
router.get("/gallery/:id", controller.getGalleryPost);
router.post(
  "/gallery",
  auth,
  ...singleImage("gallery", "image"),
  validate(
    z.object({
      body: galleryBody,
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createGalleryPost,
);
router.put(
  "/gallery/:id",
  auth,
  ...singleImage("gallery", "image"),
  validate(
    z.object({
      body: galleryBody,
      params: z.object({ id: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.updateGalleryPost,
);
router.delete("/gallery/:id", auth, controller.deleteGalleryPost);
router.post("/gallery/:id/like", auth, controller.toggleLike);

module.exports = router;
