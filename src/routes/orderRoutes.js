const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/orderController");
const auth = require("../middleware/authMiddleware");
const { hasShop } = require("../middleware/roleMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.post(
  "/",
  auth,
  validate(
    z.object({
      body: z.object({
        items: z
          .array(
            z.object({
              listingId: z.string().min(1),
              quantity: z.coerce.number().int().positive().optional(),
            }),
          )
          .min(1),
        delivery: z
          .object({
            method: z.enum(["pickup", "delivery"]).optional(),
            address: z
              .object({
                region: z.string().optional(),
                city: z.string().optional(),
                street: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.placeOrder,
);
router.get("/me/buying", auth, controller.getBuyingOrders);
router.get("/me/selling", auth, hasShop, controller.getSellingOrders);
router.get("/:id", auth, controller.getOrder);
router.put(
  "/:id/shipped",
  auth,
  hasShop,
  validate(
    z.object({
      body: z.object({ trackingInfo: z.string().optional() }),
      params: z.object({ id: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.markShipped,
);
router.put("/:id/confirm-delivery", auth, controller.confirmDelivery);
router.post(
  "/:id/dispute",
  auth,
  validate(
    z.object({
      body: z.object({ reason: z.string().min(2) }),
      params: z.object({ id: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.raiseDispute,
);

module.exports = router;
