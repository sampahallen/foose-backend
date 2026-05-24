const express = require("express");
const controller = require("../controllers/searchController");

const router = express.Router();

router.get("/featured", controller.getFeatured);
router.get("/top-picks", controller.getTopPicks);
router.get("/popular-searches", controller.getPopularSearches);
router.get("/top-sellers", controller.getTopSellers);
router.get("/", controller.searchListings);

module.exports = router;
