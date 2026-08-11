const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/bargainController");
const auth = require("../middleware/authMiddleware");
const requireEmailVerified = require("../middleware/emailVerificationMiddleware");
const validate = require("../middleware/validateMiddleware");
const { bargainLimiter } = require("../middleware/rateLimitMiddleware");
const { BARGAIN_STATUSES } = require("../constants/bargain");

const router = express.Router();

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Provide a valid id");

// Amounts are integer pesewas. The "must be below the listed price" rule needs
// the listing, so it lives in bargainRules rather than here.
const offerAmount = z.coerce.number().int().positive();
const offerNote = z.string().trim().max(280).optional();

const listQuerySchema = z.object({
  role: z.enum(["buyer", "seller"]).optional(),
  status: z.enum(BARGAIN_STATUSES).optional(),
  listingId: objectId.optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
}).strict();

const createBodySchema = z.object({
  listingId: objectId,
  amount: offerAmount,
  note: offerNote,
}).strict();

const counterBodySchema = z.object({
  amount: offerAmount,
  note: offerNote,
}).strict();

const noBodySchema = z.object({
  note: offerNote,
}).strict();

const idParams = z.object({ id: objectId });

router.use(auth, requireEmailVerified);

router.post(
  "/",
  bargainLimiter,
  validate(
    z.object({
      body: createBodySchema,
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.createBargain,
);

router.get(
  "/",
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({}),
      query: listQuerySchema,
    }),
  ),
  controller.listBargains,
);

// Declared before "/:id" so the static segment is not swallowed by the param route.
router.get(
  "/listing/:listingId/mine",
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({ listingId: objectId }),
      query: z.object({}),
    }),
  ),
  controller.getMyListingBargain,
);

router.get(
  "/:id",
  validate(
    z.object({
      body: z.any().optional(),
      params: idParams,
      query: z.object({}),
    }),
  ),
  controller.getBargain,
);

router.post(
  "/:id/counter",
  bargainLimiter,
  validate(
    z.object({
      body: counterBodySchema,
      params: idParams,
      query: z.object({}),
    }),
  ),
  controller.counterBargain,
);

for (const [path, handler] of [
  ["accept", controller.acceptBargain],
  ["decline", controller.declineBargain],
  ["cancel", controller.cancelBargain],
]) {
  router.post(
    `/:id/${path}`,
    bargainLimiter,
    validate(
      z.object({
        body: noBodySchema,
        params: idParams,
        query: z.object({}),
      }),
    ),
    handler,
  );
}

module.exports = router;
module.exports.createBodySchema = createBodySchema;
module.exports.counterBodySchema = counterBodySchema;
module.exports.listQuerySchema = listQuerySchema;
