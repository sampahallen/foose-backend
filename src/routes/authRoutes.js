const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/authController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");
const { authLimiter } = require("../middleware/rateLimitMiddleware");

const router = express.Router();

const password = z.string().min(1);
const strongPassword = z
  .string()
  .min(8)
  .regex(/[A-Z]/, "Password must include a capital letter")
  .regex(/\d/, "Password must include a number")
  .regex(/[^A-Za-z0-9]/, "Password must include a symbol");

router.get("/oauth/google", authLimiter, controller.startGoogleOAuth);
router.get("/oauth/apple", authLimiter, controller.startAppleOAuth);
router.get("/oauth/google/callback", authLimiter, controller.googleCallback);
router.post("/oauth/apple/callback", authLimiter, controller.appleCallback);
router.get("/oauth/apple/callback", authLimiter, controller.appleCallback);

router.post(
  "/register",
  authLimiter,
  validate(
    z.object({
      body: z.object({
        name: z.string().min(2),
        email: z.string().email(),
        username: z.string().regex(/^[a-zA-Z0-9_.]{3,20}$/),
        password: strongPassword,
        phone: z.string().optional(),
        location: z
          .object({
            region: z.string().optional(),
            city: z.string().optional(),
          })
          .optional(),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.register,
);

router.post(
  "/login",
  authLimiter,
  validate(
    z.object({
      body: z
        .object({
          identifier: z.string().optional(),
          email: z.string().optional(),
          username: z.string().optional(),
          password,
        })
        .refine((body) => body.identifier || body.email || body.username, {
          message: "identifier, email, or username is required",
        }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.login,
);

router.post(
  "/refresh",
  validate(
    z.object({
      body: z.object({ refreshToken: z.string().min(1) }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.refresh,
);

router.post(
  "/logout",
  auth,
  validate(
    z.object({
      body: z.object({ refreshToken: z.string().optional() }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.logout,
);

router.get("/verify-email/:token", authLimiter, controller.verifyEmail);

router.post(
  "/forgot-password",
  authLimiter,
  validate(
    z.object({
      body: z.object({ email: z.string().email() }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.forgotPassword,
);

router.post(
  "/reset-password/:token",
  authLimiter,
  validate(
    z.object({
      body: z.object({ password: strongPassword }),
      params: z.object({ token: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.resetPassword,
);

module.exports = router;
