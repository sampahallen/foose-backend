const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/userController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");
const { singleImage } = require("../middleware/uploadMiddleware");

const router = express.Router();
const usernameAvailabilityQuerySchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.]{3,20}$/)
    .transform((username) => username.toLowerCase()),
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
router.get("/:username/follow", auth, controller.followStatus);
router.post("/:username/follow", auth, controller.toggleFollow);
router.get("/:username/profile", controller.getProfileByUsername);
router.get("/:username", controller.getPublicProfile);

module.exports = router;
module.exports.usernameAvailabilityQuerySchema = usernameAvailabilityQuerySchema;
