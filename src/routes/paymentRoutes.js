const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/paymentController");
const auth = require("../middleware/authMiddleware");
const requireEmailVerified = require("../middleware/emailVerificationMiddleware");
const { hasShop } = require("../middleware/roleMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.post(
  "/initialize",
  auth,
  requireEmailVerified,
  validate(
    z.object({
      body: z.object({
        callbackUrl: z.string().url().optional(),
        orderId: z.string().min(1),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.initializePayment,
);
router.get("/verify/:reference", auth, controller.verifyPayment);
router.delete(
  "/:reference",
  auth,
  validate(
    z.object({
      body: z.object({}).optional(),
      params: z.object({
        reference: z.string().min(1).max(128).regex(/^[A-Za-z0-9._=-]+$/),
      }),
      query: z.object({}),
    }),
  ),
  controller.cancelPayment,
);
router.post(
  "/promotions/initialize",
  auth,
  requireEmailVerified,
  validate(
    z.object({
      body: z.object({
        callbackUrl: z.string().url().optional(),
        packageName: z.enum(["basic", "lite", "premium"]).optional(),
        targetId: z.string().min(1).optional(),
        targetIds: z.array(z.string().min(1)).max(30).optional(),
        targetType: z.enum(["listing", "event"]),
      }).refine((body) => body.targetId || body.targetIds?.length, {
        message: "targetId or targetIds is required",
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.initializePromotionPayment,
);
router.get("/promotions/verify/:reference", auth, controller.verifyPromotionPayment);
router.post("/webhook", controller.webhook);
router.post(
  "/withdraw",
  auth,
  hasShop,
  validate(
    z.object({
      body: z.object({
        amount: z.coerce.number().int().positive(),
        recipient: z.string().min(1),
        reason: z.string().optional(),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.withdraw,
);

module.exports = router;
