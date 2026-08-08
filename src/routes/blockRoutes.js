const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/blockController");
const auth = require("../middleware/authMiddleware");
const requireEmailVerified = require("../middleware/emailVerificationMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

const userIdParams = z.object({
  userId: z.string().min(1),
});

router.use(auth, requireEmailVerified);

router.get("/", controller.listBlocked);
router.get(
  "/status/:userId",
  validate(
    z.object({
      body: z.object({}).optional(),
      params: userIdParams,
      query: z.object({}),
    }),
  ),
  controller.blockStatus,
);
router.post(
  "/:userId",
  validate(
    z.object({
      body: z.object({}).optional(),
      params: userIdParams,
      query: z.object({}),
    }),
  ),
  controller.blockUser,
);
router.delete(
  "/:userId",
  validate(
    z.object({
      body: z.object({}).optional(),
      params: userIdParams,
      query: z.object({}),
    }),
  ),
  controller.unblockUser,
);

module.exports = router;
