const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/promotionController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");
const { promotionMetricLimiter } = require("../middleware/rateLimitMiddleware");

const router = express.Router();

router.get(
  "/me",
  auth,
  validate(z.object({ body: z.any().optional(), params: z.object({}), query: z.object({ targetType: z.enum(["listing", "event"]).optional() }).strict() })),
  controller.listMine,
);
router.post(
  "/listings/:listingId/metrics",
  promotionMetricLimiter,
  validate(z.object({
    body: z.object({ metric: z.enum(["impression", "click"]), sessionId: z.string().min(8).max(96) }).strict(),
    params: z.object({ listingId: z.string().regex(/^[a-f\d]{24}$/i) }),
    query: z.object({}),
  })),
  controller.recordListingMetric,
);

module.exports = router;
