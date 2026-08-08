const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/reportController");
const auth = require("../middleware/authMiddleware");
const requireEmailVerified = require("../middleware/emailVerificationMiddleware");
const validate = require("../middleware/validateMiddleware");
const { USER_REPORT_REASONS } = require("../constants/userReports");

const router = express.Router();

router.use(auth, requireEmailVerified);

router.post(
  "/",
  validate(
    z.object({
      body: z.object({
        reportedUserId: z.string().min(1),
        reason: z.enum(USER_REPORT_REASONS),
        details: z.string().trim().max(2000).optional(),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createReport,
);

module.exports = router;
