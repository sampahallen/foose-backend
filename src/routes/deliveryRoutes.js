const express = require("express");
const controller = require("../controllers/deliveryController");

const router = express.Router();

router.get("/estimate", controller.estimate);

module.exports = router;
