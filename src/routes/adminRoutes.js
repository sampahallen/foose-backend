const express = require("express");
const { z } = require("zod");
const { STAFF_ROLE_KEYS } = require("../constants/roles");
const controller = require("../controllers/adminController");
const auth = require("../middleware/authMiddleware");
const {
  canResolveDisputes,
  canReviewKyc,
  isSuperAdmin,
} = require("../middleware/roleMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.use(auth);

router.get("/stats", isSuperAdmin, controller.stats);
router.get(
  "/analytics",
  isSuperAdmin,
  validate(
    z.object({
      body: z.object({}).optional().default({}),
      params: z.object({}),
      query: z.object({
        days: z.enum(["7", "14", "30"]).optional(),
      }),
    }),
  ),
  controller.analytics,
);
router.post(
  "/announcements",
  isSuperAdmin,
  validate(
    z.object({
      body: z.object({
        body: z.string().trim().max(1000).optional().default(""),
        link: z.string().trim().max(500).optional().default(""),
        title: z.string().trim().min(3).max(120),
      }).strict(),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createAnnouncement,
);
router.get(
  "/users",
  isSuperAdmin,
  validate(
    z.object({
      body: z.object({}).optional().default({}),
      params: z.object({}),
      query: z.object({
        limit: z.string().optional(),
        page: z.string().optional(),
        search: z.string().max(120).optional(),
      }),
    }),
  ),
  controller.users,
);
router.put(
  "/users/:userId/roles/:roleKey",
  isSuperAdmin,
  validate(
    z.object({
      body: z.object({}).optional().default({}),
      params: z.object({
        roleKey: z.enum([...STAFF_ROLE_KEYS]),
        userId: z.string().min(1),
      }),
      query: z.object({}),
    }),
  ),
  controller.promoteUser,
);
router.delete(
  "/users/:userId/roles/:roleKey",
  isSuperAdmin,
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({
        roleKey: z.enum([...STAFF_ROLE_KEYS]),
        userId: z.string().min(1),
      }),
      query: z.object({}),
    }),
  ),
  controller.demoteUser,
);
router.get("/kyc/pending", canReviewKyc, controller.pendingKyc);
router.get(
  "/kyc/approved",
  canReviewKyc,
  validate(
    z.object({
      body: z.object({}).optional().default({}),
      params: z.object({}),
      query: z.object({
        idType: z.enum(["Ghana Card", "Passport", "Driving License"]).optional(),
        limit: z.string().optional(),
        page: z.string().optional(),
        phoneVerified: z.enum(["true", "false"]).optional(),
        reviewedWithin: z.enum(["7", "30", "90"]).optional(),
        search: z.string().max(120).optional(),
        sort: z.enum(["newest", "oldest"]).optional(),
      }),
    }),
  ),
  controller.approvedKyc,
);
router.get("/kyc/:kycId", canReviewKyc, controller.getKyc);
router.put("/kyc/:kycId/approve", canReviewKyc, controller.approveKyc);
router.put(
  "/kyc/:kycId/reject",
  canReviewKyc,
  validate(
    z.object({
      body: z.object({ reason: z.string().trim().max(1000).optional().default("") }).optional().default({}),
      params: z.object({ kycId: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.rejectKyc,
);
router.get("/listings/flagged", isSuperAdmin, controller.flaggedListings);
router.delete("/listings/:id", isSuperAdmin, controller.removeListing);
router.get("/disputes", canResolveDisputes, controller.disputes);
router.put(
  "/disputes/:orderId/resolve",
  canResolveDisputes,
  validate(
    z.object({
      body: z.object({ resolveFor: z.enum(["seller", "buyer"]) }),
      params: z.object({ orderId: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.resolveDispute,
);

module.exports = router;
