const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/userController");
const auth = require("../middleware/authMiddleware");
const optionalAuth = require("../middleware/optionalAuthMiddleware");
const validate = require("../middleware/validateMiddleware");
const { singleImage } = require("../middleware/uploadMiddleware");
const { emailChangeLimiter } = require("../middleware/rateLimitMiddleware");
const { isDisposableEmail } = require("../utils/email");

const router = express.Router();
const newAccountEmail = z
  .string()
  .trim()
  .email()
  .transform((email) => email.toLowerCase())
  .refine((email) => !isDisposableEmail(email), {
    message: "Disposable or temporary email addresses are not allowed",
  });
const usernameAvailabilityQuerySchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.]{3,20}$/)
    .transform((username) => username.toLowerCase()),
}).strict();
const profileContentQuerySchema = z.object({
  type: z.enum(["finspo", "listings", "events"]),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(24).default(12),
}).strict();
const profileConnectionsQuerySchema = z.object({
  type: z.enum(["followers", "following"]),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(30).default(30),
}).strict();
const profileUsernameSchema = z.object({
  username: z.string().trim().min(1).transform((username) => username.toLowerCase()),
}).strict();
const notificationCategorySchema = z.object({ email: z.boolean() }).strict().partial();
const systemNotificationCategorySchema = z.object({ email: z.boolean(), inApp: z.boolean() }).strict().partial();
const preferencesBodySchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  notifications: z.object({
    order: notificationCategorySchema.optional(),
    chat: notificationCategorySchema.optional(),
    review: notificationCategorySchema.optional(),
    system: systemNotificationCategorySchema.optional(),
  }).strict().optional(),
}).strict();

router.get("/me", auth, controller.getMe);
router.get("/me/profile", auth, controller.getMyProfile);
router.get(
  "/username-availability",
  auth,
  validate(
    z.object({
      body: z.any().optional(),
      params: z.object({}),
      query: usernameAvailabilityQuerySchema,
    }),
  ),
  controller.usernameAvailability,
);
router.put(
  "/me",
  auth,
  ...singleImage("profiles", "profilePhoto"),
  validate(
    z.object({
      body: z.object({
        name: z.string().min(1).optional(),
        username: z.string().regex(/^[a-zA-Z0-9_.]{3,20}$/).optional(),
        bio: z.string().max(280).optional(),
        phone: z.string().optional(),
        region: z.string().optional(),
        city: z.string().optional(),
      }).strict(),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.updateMe,
);
router.put(
  "/me/password",
  auth,
  validate(
    z.object({
      body: z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(6),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.changePassword,
);
router.put(
  "/me/preferences",
  auth,
  validate(
    z.object({
      body: preferencesBodySchema,
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.updatePreferences,
);
router.post(
  "/me/email-change",
  auth,
  emailChangeLimiter,
  validate(
    z.object({
      body: z.object({
        currentPassword: z.string().min(1),
        newEmail: newAccountEmail,
      }).strict(),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.requestEmailChange,
);
router.post(
  "/email-change/confirm",
  validate(
    z.object({
      body: z.object({ token: z.string().min(1) }).strict(),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.confirmEmailChange,
);
router.post("/me/deactivate", auth, controller.deactivateMe);
router.delete(
  "/me",
  auth,
  validate(
    z.object({
      body: z.object({ confirmation: z.literal("DELETE") }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.deleteMe,
);
router.delete(
  "/me/followers/:username",
  auth,
  validate(
    z.object({
      body: z.any().optional(),
      params: profileUsernameSchema,
      query: z.object({}),
    }),
  ),
  controller.removeFollower,
);
router.get("/:username/follow", auth, controller.followStatus);
router.post("/:username/follow", auth, controller.toggleFollow);
router.delete(
  "/:username/follow",
  auth,
  validate(
    z.object({
      body: z.any().optional(),
      params: profileUsernameSchema,
      query: z.object({}),
    }),
  ),
  controller.unfollowUser,
);
router.get(
  "/:username/connections",
  optionalAuth,
  validate(
    z.object({
      body: z.any().optional(),
      params: profileUsernameSchema,
      query: profileConnectionsQuerySchema,
    }),
  ),
  controller.getProfileConnections,
);
router.get(
  "/:username/profile/content",
  validate(
    z.object({
      body: z.any().optional(),
      params: profileUsernameSchema,
      query: profileContentQuerySchema,
    }),
  ),
  controller.getProfileContent,
);
router.get("/:username/profile", optionalAuth, controller.getProfileByUsername);
router.get("/:username", controller.getPublicProfile);

module.exports = router;
module.exports.usernameAvailabilityQuerySchema = usernameAvailabilityQuerySchema;
module.exports.profileContentQuerySchema = profileContentQuerySchema;
module.exports.profileConnectionsQuerySchema = profileConnectionsQuerySchema;
