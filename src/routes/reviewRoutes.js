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
        orderId: z.string().min(1),
        rating: z.coerce.number().int().min(1).max(5),
        comment: z.string().optional(),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createReview,
);
router.get("/shop/:shopId", controller.getShopReviews);

module.exports = router;
