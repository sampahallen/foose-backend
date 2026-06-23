const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/digishopController");
const auth = require("../middleware/authMiddleware");
const { hasShop, isKycVerified } = require("../middleware/roleMiddleware");
const validate = require("../middleware/validateMiddleware");
const { shopImages } = require("../middleware/uploadMiddleware");

const router = express.Router();

const shopBody = z.object({
  shopName: z.string().min(2).optional(),
  bio: z.string().optional(),
  category: z.enum(["retail", "wholesale", "both"]).optional(),
  instagram: z.string().optional(),
  whatsapp: z.string().optional(),
  payoutMethodType: z.enum(["mobile_money", "bank_transfer"]).optional(),
  payoutAccountName: z.string().optional(),
  payoutProvider: z.string().optional(),
  payoutAccountNumber: z.string().optional(),
  payoutBankName: z.string().optional(),
  payoutBranch: z.string().optional(),
}).strict();

router.post(
  "/",
  auth,
  isKycVerified,
  ...shopImages,
  validate(
    z.object({
      body: shopBody.extend({ shopName: z.string().min(2) }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createShop,
);
router.get("/me", auth, hasShop, controller.getMyShop);
router.put(
  "/me",
  auth,
  hasShop,
  ...shopImages,
  validate(
    z.object({
      body: shopBody,
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.updateMyShop,
);
router.get("/", controller.listShops);
router.get("/:slug", controller.getShopBySlug);

module.exports = router;
