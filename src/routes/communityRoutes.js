const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/communityController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");
const { singleImage } = require("../middleware/uploadMiddleware");

const router = express.Router();

router.get("/events", controller.listEvents);
router.post(
  "/events",
  auth,
  ...singleImage("events", "coverImage"),
  validate(
    z.object({
      body: z.object({
        title: z.string().min(2),
        description: z.string().optional(),
        date: z.string().min(1),
        location: z.string().optional(),
        coverImage: z.string().optional(),
        type: z.enum(["pop-up", "fair", "online"]),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createEvent,
);
router.post("/events/:id/attend", auth, controller.toggleAttend);
router.get("/gallery", controller.listGallery);
router.post(
  "/gallery",
  auth,
  ...singleImage("gallery", "image"),
  validate(
    z.object({
      body: z.object({
        imageUrl: z.string().optional(),
        caption: z.string().optional(),
        tags: z.any().optional(),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createGalleryPost,
);
router.post("/gallery/:id/like", auth, controller.toggleLike);

module.exports = router;
