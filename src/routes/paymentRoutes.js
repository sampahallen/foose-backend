const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/paymentController");
const auth = require("../middleware/authMiddleware");
const { hasShop } = require("../middleware/roleMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.post(
  "/initialize",
  auth,
  validate(
    z.object({
      body: z.object({ orderId: z.string().min(1) }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.initializePayment,
);
router.get("/verify/:reference", auth, controller.verifyPayment);
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
