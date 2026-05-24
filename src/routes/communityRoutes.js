const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/communityController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");
const { singleImage } = require("../middleware/uploadMiddleware");

const router = express.Router();

const eventBody = z.object({
  title: z.string().min(2).optional(),
  description: z.string().optional(),
  date: z.string().min(1).optional(),
  location: z.string().optional(),
  type: z.enum(["pop-up", "fair", "online"]).optional(),
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
        type: z.enum(["pop-up", "fair", "online"]),
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
