const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/adminController");
const auth = require("../middleware/authMiddleware");
const { isAdmin } = require("../middleware/roleMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.use(auth, isAdmin);

router.get("/stats", controller.stats);
router.get("/kyc/pending", controller.pendingKyc);
router.get("/kyc/:kycId", controller.getKyc);
router.put("/kyc/:kycId/approve", controller.approveKyc);
router.put(
  "/kyc/:kycId/reject",
  validate(
    z.object({
      body: z.object({ reason: z.string().min(2) }),
      params: z.object({ kycId: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.rejectKyc,
);
router.get("/listings/flagged", controller.flaggedListings);
router.delete("/listings/:id", controller.removeListing);
router.get("/disputes", controller.disputes);
router.put(
  "/disputes/:orderId/resolve",
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
