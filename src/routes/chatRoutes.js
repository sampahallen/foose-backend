const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/chatController");
const auth = require("../middleware/authMiddleware");
const { chatAttachments } = require("../middleware/uploadMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.get("/", auth, controller.listConversations);
router.get("/:conversationId", auth, controller.listConversation);
router.post(
  "/",
  auth,
  ...chatAttachments,
  validate(
    z.object({
      body: z.object({
        conversationId: z.string().min(1).optional(),
        receiverId: z.string().min(1).optional(),
        listingId: z.string().min(1).optional(),
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
router.put("/:conversationId/read", auth, controller.markRead);

module.exports = router;
