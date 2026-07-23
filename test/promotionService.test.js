const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  MAX_LISTINGS_PER_ORDER,
  PROMOTION_TIERS,
  serializePromotionOrder,
  tierConfig,
  uniqueIds,
} = require("../src/services/promotionService");

test("promotion tiers use the approved per-listing prices and durations", () => {
  assert.deepEqual(PROMOTION_TIERS.quick_boost, { targetType: "listing", label: "Quick Boost", unitAmount: 1000, durationHours: 24 });
  assert.deepEqual(PROMOTION_TIERS.weekend_push, { targetType: "listing", label: "Weekend Push", unitAmount: 3000, durationHours: 72 });
  assert.deepEqual(PROMOTION_TIERS.top_pick, { targetType: "listing", label: "Top Pick", unitAmount: 5000, durationHours: 168 });
  assert.equal(PROMOTION_TIERS.homepage_feature.unitAmount, 3000);
  assert.equal(PROMOTION_TIERS.homepage_feature.durationHours, 168);
  assert.equal(MAX_LISTINGS_PER_ORDER, 30);
  assert.equal(tierConfig("homepage_feature", "listing"), null);
});

test("promotion target ids are trimmed and deduplicated", () => {
  assert.deepEqual(uniqueIds([" one ", "two", "one", "", null]), ["one", "two"]);
});

test("seller analytics expose campaign state and click-through rate", () => {
  const serialized = serializePromotionOrder({
    paymentStatus: "paid",
    items: [{ targetId: "listing", startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 10000), impressions: 20, clicks: 3 }],
  });
  assert.equal(serialized.items[0].status, "active");
  assert.equal(serialized.items[0].clickThroughRate, 15);
});

test("ordinary listing and event request schemas cannot assign paid promotion tags", () => {
  const listingRoutes = fs.readFileSync(path.join(__dirname, "../src/routes/listingRoutes.js"), "utf8");
  const communityRoutes = fs.readFileSync(path.join(__dirname, "../src/routes/communityRoutes.js"), "utf8");
  assert.doesNotMatch(listingRoutes, /promotionTags:\s*z\./);
  assert.doesNotMatch(communityRoutes, /promotionTags:\s*z\./);
});
