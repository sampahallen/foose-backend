const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DWELL_POINTS,
  RECOMMENDATION_POINTS,
  RECOMMENDATION_SIGNALS,
  SUGGESTED_FEED,
} = require("../src/constants/recommendations");
const { dwellPoints, scoreListing } = require("../src/services/recommendationService");
const {
  composeFirstPage,
  composePersonalizedFeed,
  createSeededRandom,
  promotedSlots,
  selectSuggestedCandidates,
} = require("../src/utils/recommendationFeed");
const { normalizeHashtags } = require("../src/utils/hashtags");

const items = (prefix, count) => Array.from({ length: count }, (_, index) => ({ _id: `${prefix}-${index}` }));

test("recommendation signal presets match the product rules", () => {
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.PURCHASE], 50);
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.FAVORITE], 20);
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.FINSPO_LIKE], 20);
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.FINSPO_CREATOR_FOLLOW], 30);
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.ADD_TO_CART], 15);
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.VIEW], 2);
});

test("dwell thresholds award one non-cumulative score", () => {
  assert.equal(dwellPoints(500), DWELL_POINTS.UNDER_ONE_SECOND);
  assert.equal(dwellPoints(1000), 0);
  assert.equal(dwellPoints(3000), 0);
  assert.equal(dwellPoints(3001), DWELL_POINTS.OVER_THREE_SECONDS);
  assert.equal(dwellPoints(10000), DWELL_POINTS.OVER_THREE_SECONDS);
  assert.equal(dwellPoints(10001), DWELL_POINTS.OVER_TEN_SECONDS);
});

test("listing hashtags are normalized and deduplicated", () => {
  assert.deepEqual(
    normalizeHashtags("#StreetWear, streetwear  Y2K  old.money"),
    ["streetwear", "y2k", "oldmoney"],
  );
});

test("listing scores combine item affinities with Finspo hashtags and creators", () => {
  const profile = {
    itemAffinities: {
      category: { tops: 10 },
      color: { red: 5 },
      digishopId: { "shop-1": 7 },
      hashtags: { streetwear: 20 },
      location: { "accra,_greater_accra": 4 },
      size: { m: 3 },
    },
    finspoAffinities: {
      creatorId: { "owner-1": 8 },
      hashtags: { streetwear: 30 },
    },
  };
  const listing = {
    category: "Tops",
    color: "red",
    hashtags: ["streetwear"],
    shopId: {
      _id: "shop-1",
      location: { city: "Accra", region: "Greater Accra" },
      ownerId: "owner-1",
    },
    size: "M",
  };

  assert.equal(scoreListing(profile, listing), 87);
});

test("listing location scoring uses the posted snapshot before the shop's current location", () => {
  const profile = {
    itemAffinities: {
      location: {
        "accra,_greater_accra": 2,
        "takoradi,_western": 9,
      },
    },
  };
  const listing = {
    location: { city: "Takoradi", region: "Western" },
    shopId: {
      _id: "shop-1",
      location: { city: "Accra", region: "Greater Accra" },
    },
  };

  assert.equal(scoreListing(profile, listing), 9);
});

test("the 85-seat first page keeps the 20/15/15 allocation and six-position promoted gaps", () => {
  const input = {
    fillers: items("fill", 100),
    newCount: 15,
    newItems: items("new", 40),
    pageSize: 85,
    promoted: items("promoted", 20),
    promotedCount: 15,
    requestedGap: 6,
    seed: "user:day:query",
    suggested: items("suggested", 40),
    suggestedCount: 20,
  };
  const first = composeFirstPage(input);
  const second = composeFirstPage(input);

  assert.deepEqual(first.allocations, { new: 15, promoted: 15, suggested: 20 });
  assert.equal(first.results.length, 85);
  assert.deepEqual(first.results, second.results);

  const promotedIndexes = first.results
    .map((item, index) => item._id.startsWith("promoted-") ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(promotedIndexes.length, 15);
  assert.equal(Math.min(...promotedIndexes.slice(1).map((index, position) => index - promotedIndexes[position])), 6);
});

test("a six-position promoted gap is enforced whenever the ratio makes it feasible", () => {
  const result = promotedSlots(85, 15, 6, createSeededRandom("feasible"));
  const gaps = result.slots.slice(1).map((slot, index) => slot - result.slots[index]);

  assert.equal(result.actualGap, 6);
  assert.ok(gaps.every((gap) => gap >= 6));
});

test("suggested feeds use 500 scored candidates and 50-item pages", () => {
  assert.equal(SUGGESTED_FEED.CANDIDATE_LIMIT, 500);
  assert.equal(SUGGESTED_FEED.MINIMUM_SCORE, 1);
  assert.equal(SUGGESTED_FEED.PAGE_SIZE, 50);
});

test("suggested feeds fall back to a stable randomized candidate set when no item is scored", () => {
  const scoredCandidates = items("candidate", 20).map((listing, index) => ({
    listing,
    score: 0,
    tie: index / 20,
  }));
  const input = {
    minimumScore: SUGGESTED_FEED.MINIMUM_SCORE,
    scoredCandidates,
    seed: "new-user:day:retail",
  };
  const first = selectSuggestedCandidates(input);
  const second = selectSuggestedCandidates(input);

  assert.equal(first.personalized, false);
  assert.equal(first.results.length, scoredCandidates.length);
  assert.deepEqual(first.results, second.results);
  assert.notDeepEqual(first.results, scoredCandidates.map(({ listing }) => listing));
  assert.deepEqual(
    new Set(first.results.map((listing) => listing._id)),
    new Set(scoredCandidates.map(({ listing }) => listing._id)),
  );
});

test("suggested feeds keep scored personalization when qualifying items exist", () => {
  const scoredCandidates = [
    { listing: { _id: "zero" }, score: 0, tie: 0.1 },
    { listing: { _id: "lower" }, score: 2, tie: 0.2 },
    { listing: { _id: "higher" }, score: 8, tie: 0.3 },
  ];
  const selected = selectSuggestedCandidates({
    minimumScore: SUGGESTED_FEED.MINIMUM_SCORE,
    scoredCandidates,
    seed: "returning-user:day:retail",
  });

  assert.equal(selected.personalized, true);
  assert.deepEqual(selected.results.map((listing) => listing._id), ["higher", "lower"]);
});

test("personalized promotions are randomized deterministically and stay separated across pages", () => {
  const input = {
    promoted: items("promoted", 80),
    regular: items("personalized", 420),
    requestedGap: 6,
    seed: "user:day:suggested",
  };
  const first = composePersonalizedFeed(input);
  const second = composePersonalizedFeed(input);
  const promotedIndexes = first.results
    .map((item, index) => item._id.startsWith("promoted-") ? index : -1)
    .filter((index) => index >= 0);
  const gaps = promotedIndexes.slice(1).map((index, position) => index - promotedIndexes[position]);

  assert.equal(first.results.length, 500);
  assert.equal(first.promotedCount, 80);
  assert.equal(first.actualGap, 6);
  assert.deepEqual(first.results, second.results);
  assert.ok(gaps.every((gap) => gap >= 6));
});
