const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/authController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");
const { authLimiter } = require("../middleware/rateLimitMiddleware");

const router = express.Router();

const password = z.string().min(6);

router.post(
  "/register",
  authLimiter,
  validate(
    z.object({
      body: z.object({
        name: z.string().min(2),
        email: z.string().email(),
        username: z.string().regex(/^[a-zA-Z0-9_]{3,20}$/),
        password,
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

router.get("/verify-email/:token", controller.verifyEmail);

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
      body: z.object({ password }),
      params: z.object({ token: z.string().min(1) }),
      query: z.object({}),
    }),
  ),
  controller.resetPassword,
);

module.exports = router;
