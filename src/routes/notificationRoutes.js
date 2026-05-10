const express = require("express");
const controller = require("../controllers/notificationController");
const auth = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", auth, controller.listNotifications);
router.put("/read-all", auth, controller.markAllRead);
router.put("/:id/read", auth, controller.markRead);

module.exports = router;
