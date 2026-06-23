const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/reviewController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.post(
  "/",
  auth,
  validate(
    z.object({
      body: z.object({
        orderId: z.string().min(1).optional(),
        shopId: z.string().min(1).optional(),
        rating: z.coerce.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
      }).refine((body) => body.orderId || body.shopId, {
        message: "orderId or shopId is required",
        path: ["shopId"],
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createReview,
);
router.get("/shop/:shopId", controller.getShopReviews);
router.put(
  "/:reviewId",
  auth,
  validate(
    z.object({
      body: z.object({
        rating: z.coerce.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
      }),
      params: z.object({ reviewId: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.updateReview,
);
router.delete(
  "/:reviewId",
  auth,
  validate(
    z.object({
      body: z.object({}).optional(),
      params: z.object({ reviewId: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.deleteReview,
);

module.exports = router;
