const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/listingController");
const auth = require("../middleware/authMiddleware");
const { hasShop } = require("../middleware/roleMiddleware");
const validate = require("../middleware/validateMiddleware");
const { listingImages } = require("../middleware/uploadMiddleware");

const router = express.Router();

const listingBody = z.object({
  title: z.string().min(2).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  size: z.string().optional(),
  gender: z.enum(["men", "women", "unisex", "kids"]).optional(),
  condition: z.enum(["new", "used", "bale"]).optional(),
  type: z.enum(["retail", "wholesale"]).optional(),
  price: z.coerce.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  quantity: z.coerce.number().int().nonnegative().optional(),
  bulkMinQty: z.coerce.number().int().nonnegative().optional(),
  bulkWeight: z.string().optional(),
  volumeDiscounts: z.any().optional(),
  status: z.enum(["active", "sold", "draft", "removed"]).optional(),
});

router.get("/", controller.listListings);
router.get("/shop/:shopId", controller.getShopListings);
router.get("/:id", controller.getListing);
router.post(
  "/",
  auth,
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
