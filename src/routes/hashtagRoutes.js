const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/hashtagController");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.get(
  "/suggestions",
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({}),
      query: z.object({
        q: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(20).optional(),
      }),
    }),
  ),
  controller.suggestHashtags,
);

module.exports = router;
