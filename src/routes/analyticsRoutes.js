const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/analyticsController");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.post(
  "/events",
  validate(
    z.object({
      body: z.object({
        endpoint: z.string().max(300).optional(),
        message: z.string().max(600).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        method: z.string().max(16).optional(),
        path: z.string().max(300).optional(),
        severity: z.enum(["info", "warning", "error", "critical"]).optional(),
        source: z.enum(["marketplace", "admin", "backend", "unknown"]).optional(),
        statusCode: z.number().int().min(100).max(599).optional(),
        type: z.enum([
          "page_view",
          "js_error",
          "unhandled_rejection",
          "api_failure",
          "resource_error",
          "custom",
        ]),
        url: z.string().max(600).optional(),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.recordEvent,
);

module.exports = router;
