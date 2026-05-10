const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/kycController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");
const { kycLimiter } = require("../middleware/rateLimitMiddleware");
const { kycDocuments } = require("../middleware/uploadMiddleware");

const router = express.Router();

const kycSchema = z.object({
  body: z.object({
    idType: z.enum(["Ghana Card", "Passport", "Driving License"]),
    idNo: z.string().min(1),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    idImgUrl: z.string().optional(),
    selfieImgUrl: z.string().optional(),
  }),
  params: z.object({}),
  query: z.object({}),
});

router.post("/", auth, kycLimiter, ...kycDocuments, validate(kycSchema), controller.submitKyc);
router.put("/", auth, kycLimiter, ...kycDocuments, validate(kycSchema), controller.resubmitKyc);
router.get("/me", auth, controller.getMyKyc);

module.exports = router;
