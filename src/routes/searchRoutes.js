const express = require("express");
const controller = require("../controllers/searchController");

const router = express.Router();

router.get("/", controller.searchListings);

module.exports = router;
