const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/searchController");
const optionalAuth = require("../middleware/optionalAuthMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();
const browseSuggestionFilterNames = [
  "brand",
  "category",
  "color",
  "condition",
  "gender",
  "location",
  "maxPrice",
  "minPrice",
  "size",
  "type",
];
const suggestionQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(10).optional(),
  scope: z.literal("items").optional(),
  type: z.enum(["retail", "wholesale"]).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  brand: z.string().trim().min(1).max(80).optional(),
  condition: z.enum(["excellent", "great", "good", "fair", "poor"]).optional(),
  color: z.string().trim().min(1).max(40).optional(),
  gender: z.enum(["men", "women", "unisex", "kids"]).optional(),
  size: z.string().trim().min(1).max(40).optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  location: z.string().trim().min(1).max(120).optional(),
}).strict().superRefine((query, context) => {
  if (browseSuggestionFilterNames.some((field) => query[field] !== undefined) && query.scope !== "items") {
    context.addIssue({
      code: "custom",
      message: "Browse filters require scope=items",
      path: ["scope"],
    });
  }
  if (query.minPrice !== undefined && query.maxPrice !== undefined && query.minPrice > query.maxPrice) {
    context.addIssue({
      code: "custom",
      message: "minPrice cannot exceed maxPrice",
      path: ["minPrice"],
    });
  }
});

router.get("/featured", optionalAuth, controller.getFeatured);
router.get("/top-picks", optionalAuth, controller.getTopPicks);
router.get("/popular-searches", controller.getPopularSearches);
router.get("/top-sellers", controller.getTopSellers);
router.get(
  "/suggestions",
  optionalAuth,
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({}),
      query: suggestionQuerySchema,
    }),
  ),
  controller.getUnifiedSuggestions,
);
router.get("/items", optionalAuth, controller.searchListings);
router.get(
  "/",
  optionalAuth,
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({}),
      query: z.object({
        q: z.string().trim().min(1).max(120).optional(),
        tag: z.string().trim().min(1).max(64).optional(),
        scope: z.enum(["all", "items", "finspo", "events", "users"]).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        cursor: z.string().max(4096).optional(),
        track: z.enum(["1", "true"]).optional(),
      }).strict().superRefine((query, context) => {
        if (Boolean(query.q) === Boolean(query.tag)) {
          context.addIssue({
            code: "custom",
            message: "Provide exactly one of q or tag",
            path: ["q"],
          });
        }
      }),
    }),
  ),
  controller.searchUnified,
);

module.exports = router;
module.exports.suggestionQuerySchema = suggestionQuerySchema;
