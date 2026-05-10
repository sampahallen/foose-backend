const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/userController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");
const { singleImage } = require("../middleware/uploadMiddleware");

const router = express.Router();

router.get("/me", auth, controller.getMe);
router.put(
  "/me",
  auth,
  ...singleImage("profiles", "profilePhoto"),
  validate(
    z.object({
      body: z.object({
        name: z.string().optional(),
        phone: z.string().optional(),
        region: z.string().optional(),
        city: z.string().optional(),
        profilePhoto: z.string().optional(),
      }),
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
router.get("/:username", controller.getPublicProfile);

module.exports = router;
