const express = require("express");
const { z } = require("zod");
const controller = require("../controllers/chatController");
const auth = require("../middleware/authMiddleware");
const validate = require("../middleware/validateMiddleware");

const router = express.Router();

router.get("/:conversationId", auth, controller.listConversation);
router.post(
  "/",
  auth,
  validate(
    z.object({
      body: z.object({
        conversationId: z.string().optional(),
        receiverId: z.string().min(1),
        listingId: z.string().optional(),
        content: z.string().min(1),
        type: z.enum(["text", "image"]).optional(),
      }),
      params: z.object({}),
      query: z.object({}),
    }),
  ),
  controller.sendMessage,
);
router.put("/:conversationId/read", auth, controller.markRead);

module.exports = router;
