const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/orderController");
const auth = require("../middleware/authMiddleware");
const requireEmailVerified = require("../middleware/emailVerificationMiddleware");
const { hasShop } = require("../middleware/roleMiddleware");
const {
  orderDispatchBill,
  orderReportEvidence,
} = require("../middleware/uploadMiddleware");
const validate = require("../middleware/validateMiddleware");
const { STATION_PICKUP_COMPANIES } = require("../constants/delivery");

const router = express.Router();

const emptyActionSchema = z.object({
  body: z.object({}).passthrough().optional().default({}),
  params: z.object({ id: z.string().min(1) }),
  query: z.object({}).passthrough(),
});

router.post(
  "/",
  auth,
  requireEmailVerified,
  validate(
    z.object({
      body: z
        .object({
          callbackUrl: z.string().url().optional(),
          checkoutIdempotencyKey: z.string().trim().min(8).max(120).optional(),
          deliveryByShop: z
            .record(
              z.string().min(1),
              z.object({
                address: z
                  .object({
                    city: z.string().optional(),
                    region: z.string().optional(),
                    street: z.string().optional(),
                  })
                  .optional(),
                company: z.string().trim().max(160).optional(),
                destination: z
                  .object({
                    preferredTerminal: z.string().trim().max(240).optional(),
                    recipientName: z.string().trim().min(2).max(160),
                    recipientPhone: z.string().trim().min(7).max(40),
                    region: z.string().trim().min(2).max(120),
                    town: z.string().trim().min(2).max(160),
                  })
                  .optional(),
                method: z
                  .enum(["station_pickup", "shop_pickup", "airport_to_airport"])
                  .optional(),
              }),
            )
            .refine((byShop) => Object.keys(byShop).length > 0, {
              message: "Delivery details are required for every seller in this checkout",
            }),
          items: z
            .array(
              z.object({
                listingId: z.string().min(1),
                quantity: z.coerce.number().int().positive().optional(),
              }),
            )
            .min(1)
            .max(100),
          mockPayment: z.boolean().optional(),
          paymentMethod: z
            .enum(["paystack_mock", "paystack", "cash_on_pickup"])
            .optional(),
        })
        .superRefine((body, context) => {
          for (const [shopId, entry] of Object.entries(body.deliveryByShop || {})) {
            const method = entry.method || "station_pickup";
            const requiresDestination = method !== "shop_pickup";
            if (
              requiresDestination &&
              !entry.destination &&
              !entry.address?.street?.trim()
            ) {
              context.addIssue({
                code: "custom",
                message: "Destination details are required for this delivery method",
                path: ["deliveryByShop", shopId, "address", "street"],
              });
            }
            if (
              method === "station_pickup" &&
              !STATION_PICKUP_COMPANIES.includes(entry.company)
            ) {
              context.addIssue({
                code: "custom",
                message: "Choose a valid bus transit company",
                path: ["deliveryByShop", shopId, "company"],
              });
            }
          }
        }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.placeOrder,
);

router.get(
  "/checkout/delivery-options",
  auth,
  validate(
    z.object({
      body: z.object({}).optional(),
      params: z.object({}),
      query: z.object({ shopIds: z.string().trim().min(1) }),
    }),
  ),
  controller.getCheckoutDeliveryOptions,
);
router.get("/", auth, controller.getOrdersByIds);
router.get("/me/buying", auth, controller.getBuyingOrders);
router.get("/me/selling", auth, hasShop, controller.getSellingOrders);
router.get(
  "/me/selling/summary",
  auth,
  hasShop,
  controller.getSellingOrdersSummary,
);
router.get("/:id/events", auth, controller.getOrderEvents);
router.get(
  ["/:id/attachments/:kind", "/:id/attachments/:kind/:index"],
  auth,
  validate(
    z.object({
      body: z.object({}).optional(),
      params: z.object({
        id: z.string().min(1),
        index: z.string().regex(/^\d+$/).optional(),
        kind: z.enum(["transit-bill", "report-evidence"]),
      }),
      query: z.object({}),
    }),
  ),
  controller.getPrivateAttachment,
);

router.post(
  "/:id/actions/cancel-cash-pickup",
  auth,
  validate(emptyActionSchema),
  controller.cancelCashPickup,
);
router.post(
  "/:id/actions/mark-pickup-ready",
  auth,
  hasShop,
  validate(
    z.object({
      body: z.object({ note: z.string().trim().max(1000).optional() }),
      params: z.object({ id: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.markPickupReady,
);
router.post(
  "/:id/actions/complete-cash-pickup",
  auth,
  hasShop,
  validate(emptyActionSchema),
  controller.completeCashPickup,
);
router.post(
  "/:id/actions/release-unclaimed-pickup",
  auth,
  hasShop,
  validate(emptyActionSchema),
  controller.releaseUnclaimedPickup,
);
router.post(
  "/:id/actions/confirm-collection",
  auth,
  validate(emptyActionSchema),
  controller.confirmCollection,
);
router.post(
  "/:id/actions/dispatch",
  auth,
  hasShop,
  ...orderDispatchBill,
  controller.dispatch,
);
router.post(
  "/:id/actions/confirm-receipt",
  auth,
  validate(emptyActionSchema),
  controller.confirmReceipt,
);
router.post(
  "/:id/actions/close-no-action",
  auth,
  validate(emptyActionSchema),
  controller.closeNoAction,
);
router.post(
  "/:id/reports",
  auth,
  ...orderReportEvidence,
  controller.createReport,
);

/* One-release adapters. They enforce the new state machine and permissions. */
router.put(
  "/:id/process",
  auth,
  hasShop,
  validate(emptyActionSchema),
  controller.processOrder,
);
router.put(
  "/:id/shipped",
  auth,
  hasShop,
  ...orderDispatchBill,
  controller.markShipped,
);
router.put(
  "/:id/pickup-ready",
  auth,
  hasShop,
  validate(
    z.object({
      body: z.object({ note: z.string().trim().max(1000).optional() }),
      params: z.object({ id: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.markPickupReady,
);
router.put(
  "/:id/confirm-delivery",
  auth,
  validate(emptyActionSchema),
  controller.confirmDelivery,
);
router.post(
  "/:id/dispute",
  auth,
  validate(emptyActionSchema),
  controller.raiseDispute,
);

router.get("/:id", auth, controller.getOrder);

module.exports = router;
