const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/favoriteController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

const targetParams = z.object({
  targetId: z.string().min(1),
  targetType: z.enum(["listing", "event"]),
});

router.use(auth);

router.get("/", controller.listFavorites);
router.get(
  "/status",
  validate(
    z.object({
      body: z.object({}).optional(),
      params: z.object({}),
      query: z.object({
        targetId: z.string().min(1),
        targetType: z.enum(["listing", "event", "finspo"]),
      }),
    }),
  ),
  controller.favoriteStatus,
);
router.post(
  "/:targetType/:targetId",
  validate(
    z.object({
      body: z.object({}).optional(),
      params: targetParams,
      query: z.object({}),
    }),
  ),
  controller.addFavorite,
);
router.delete(
  "/:targetType/:targetId",
  validate(
    z.object({
      body: z.object({}).optional(),
      params: targetParams,
      query: z.object({}),
    }),
  ),
  controller.removeFavorite,
);

module.exports = router;
