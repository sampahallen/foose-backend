const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/listingController");
const auth = require("../middleware/authMiddleware");
const requireEmailVerified = require("../middleware/emailVerificationMiddleware");
const optionalAuth = require("../middleware/optionalAuthMiddleware");
const { hasShop } = require("../middleware/roleMiddleware");
const validate = require("../middleware/validateMiddleware");
const { listingImages } = require("../middleware/uploadMiddleware");

const router = express.Router();

const listingBody = z.object({
  title: z.string().min(2).optional(),
  description: z.string().max(500).optional(),
  hashtags: z.any().optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  size: z.string().optional(),
  gender: z.enum(["men", "women", "unisex", "kids"]).optional(),
  condition: z.enum(["excellent", "great", "good", "fair", "poor"]).optional(),
  color: z.enum([
    "beige",
    "black",
    "blue",
    "brown",
    "burgundy",
    "cream",
    "cyan",
    "gold",
    "green",
    "gray",
    "ivory",
    "khaki",
    "multi",
    "navy",
    "olive",
    "orange",
    "pink",
    "purple",
    "red",
    "silver",
    "teal",
    "turquoise",
    "violet",
    "white",
    "yellow",
  ]).optional(),
  type: z.enum(["retail", "wholesale"]).optional(),
  price: z.coerce.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  quantity: z.coerce.number().int().positive().optional(),
  bulkMinQty: z.coerce.number().int().positive().optional(),
  bulkWeight: z.string().optional(),
  keptImages: z.any().optional(),
  keptImagesTouched: z.any().optional(),
  volumeDiscounts: z.any().optional(),
  promotionTags: z.any().optional(),
  visibility: z.enum(["marketplace", "event"]).optional(),
  status: z.enum(["active", "sold", "draft", "removed"]).optional(),
}).strict();

const myListingsQuerySchema = z.object({
  status: z.enum(["active", "sold", "draft"]).optional(),
}).strict();

const availabilityQuerySchema = z.object({
  ids: z.string().min(1).transform((value) => value.split(",").filter(Boolean)).refine(
    (ids) => ids.length <= 50 && ids.every((id) => /^[a-f\d]{24}$/i.test(id)),
    "Provide up to 50 valid listing IDs",
  ),
}).strict();

router.get("/", optionalAuth, controller.listListings);
router.get("/shop/:shopId", controller.getShopListings);
router.get(
  "/availability",
  optionalAuth,
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({}),
      query: availabilityQuerySchema,
    }),
  ),
  controller.getListingAvailability,
);
router.get(
  "/me",
  auth,
  hasShop,
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({}),
      query: myListingsQuerySchema,
    }),
  ),
  controller.getMyListings,
);
router.get("/:id", optionalAuth, controller.getListing);
router.post(
  "/",
  auth,
  requireEmailVerified,
  hasShop,
  ...listingImages,
  validate(
    z.object({
      body: listingBody.extend({
        title: z.string().min(2),
        type: z.enum(["retail", "wholesale"]),
        price: z.coerce.number().int().nonnegative(),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createListing,
);
router.put(
  "/:id",
  auth,
  requireEmailVerified,
  hasShop,
  ...listingImages,
  validate(
    z.object({
      body: listingBody,
      params: z.object({ id: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.updateListing,
);
router.delete("/:id", auth, hasShop, controller.deleteListing);

module.exports = router;
module.exports.listingBody = listingBody;
module.exports.myListingsQuerySchema = myListingsQuerySchema;
module.exports.availabilityQuerySchema = availabilityQuerySchema;
