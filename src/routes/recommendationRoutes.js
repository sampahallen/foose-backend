const express = require("express");
const { z } = require("zod");
const { RECOMMENDATION_SIGNALS } = require("../constants/recommendations");
const controller = require("../controllers/recommendationController");
const auth = require("../middleware/authMiddleware");
const optionalAuth = require("../middleware/optionalAuthMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.get("/feed", optionalAuth, controller.getFeed);
router.get("/finspo", optionalAuth, controller.getFinspoFeed);
router.get(
  "/explore",
  optionalAuth,
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({}),
      query: z.object({
        cursor: z.string().max(4096).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        seed: z.string().trim().max(120).optional(),
      }).strict(),
    }),
  ),
  controller.getExploreFeed,
);
router.get("/suggested", auth, controller.getSuggestedFeed);
router.post(
  "/signals",
  auth,
  validate(
    z.object({
      body: z.object({
        dwellMs: z.coerce.number().min(0).max(24 * 60 * 60 * 1000).optional(),
        listingId: z.string().min(1),
        type: z.enum([
          RECOMMENDATION_SIGNALS.ADD_TO_CART,
          RECOMMENDATION_SIGNALS.DWELL,
          RECOMMENDATION_SIGNALS.VIEW,
        ]),
      }).strict(),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.recordListingSignal,
);

router.post(
  "/finspo-signals",
  auth,
  validate(
    z.object({
      body: z.object({
        postId: z.string().min(1),
        type: z.literal(RECOMMENDATION_SIGNALS.FINSPO_SEARCH_CLICK),
      }).strict(),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.recordFinspoSignal,
);

module.exports = router;
