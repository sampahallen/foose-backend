const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/chatController");
const auth = require("../middleware/authMiddleware");
const requireEmailVerified = require("../middleware/emailVerificationMiddleware");
const { chatAttachments } = require("../middleware/uploadMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.get("/", auth, requireEmailVerified, controller.listConversations);
router.put(
  "/messages/:messageId/reaction",
  auth,
  requireEmailVerified,
  validate(
    z.object({
      body: z.object({
        reaction: z.enum(["thumbs_up", "heart", "thumbs_down", "fire", "sad", "laugh"]),
      }),
      params: z.object({
        messageId: z.string().min(1),
      }),
      query: z.object({}),
    }),
  ),
  controller.reactToMessage,
);
router.post(
  "/",
  auth,
  requireEmailVerified,
  ...chatAttachments,
  validate(
    z.object({
      body: z.object({
        conversationId: z.string().min(1).optional(),
        receiverId: z.string().min(1).optional(),
        listingId: z.string().min(1).optional(),
        replyTo: z.string().min(1).optional(),
        content: z.string().optional(),
        type: z.enum(["text", "image", "video", "mixed"]).optional(),
      }).refine((body) => body.conversationId || body.receiverId, {
        message: "receiverId or conversationId is required",
        path: ["receiverId"],
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.sendMessage,
);
router.put("/:conversationId/read", auth, requireEmailVerified, controller.markRead);
router.put("/:conversationId/reactions/read", auth, requireEmailVerified, controller.markReactionsRead);
router.get("/:conversationId", auth, requireEmailVerified, controller.listConversation);

module.exports = router;
