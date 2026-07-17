const test = require("node:test");
const assert = require("node:assert/strict");
const GalleryPost = require("../src/models/GalleryPost");
const ShadowProfile = require("../src/models/ShadowProfile");
const {
  DWELL_POINTS,
  FINSPO_ACCOUNT_SUGGESTIONS,
  FINSPO_FEED,
  RECOMMENDATION_POINTS,
  RECOMMENDATION_SIGNALS,
  SUGGESTED_FEED,
} = require("../src/constants/recommendations");
const {
  awardFinspoSignal,
  dwellPoints,
  scoreFinspo,
  scoreListing,
} = require("../src/services/recommendationService");
const {
  composeFinspoFeed,
  composeFirstPage,
  composePersonalizedFeed,
  createSeededRandom,
  promotedSlots,
  selectFinspoAccountCandidates,
  selectSuggestedCandidates,
} = require("../src/utils/recommendationFeed");
const { normalizeHashtags } = require("../src/utils/hashtags");

const items = (prefix, count) => Array.from({ length: count }, (_, index) => ({ _id: `${prefix}-${index}` }));

test("recommendation signal presets match the product rules", () => {
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.PURCHASE], 50);
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.FAVORITE], 20);
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.FINSPO_LIKE], 20);
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.FINSPO_CREATOR_FOLLOW], 30);
  assert.equal(RECOMMENDATION_POINTS[RECOMMENDATION_SIGNALS.FINSPO_SEARCH_CLICK], 2);
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

test("Finspo search clicks award two points but never reward a post owner", async () => {
  const originalPostFindOne = GalleryPost.findOne;
  const originalProfileFindOneAndUpdate = ShadowProfile.findOneAndUpdate;
  const updates = [];
  let postFilter;

  GalleryPost.findOne = (filter) => {
    postFilter = filter;
    return {
      select() {
        return this;
      },
      lean: async () => ({ userId: "creator-1", tags: ["streetwear"] }),
    };
  };
  ShadowProfile.findOneAndUpdate = async (_filter, update) => {
    updates.push(update);
    return { userId: "viewer-1" };
  };

  try {
    assert.equal(
      await awardFinspoSignal(
        "creator-1",
        "post-1",
        RECOMMENDATION_SIGNALS.FINSPO_SEARCH_CLICK,
      ),
      null,
    );
    assert.equal(updates.length, 0);

    await awardFinspoSignal(
      "viewer-1",
      "post-1",
      RECOMMENDATION_SIGNALS.FINSPO_SEARCH_CLICK,
    );

    assert.deepEqual(postFilter, { _id: "post-1", isArchived: { $ne: true } });
    assert.equal(updates.length, 2);
    assert.equal(updates[1].$inc["finspoAffinities.creatorId.creator-1"], 2);
    assert.equal(updates[1].$inc["finspoAffinities.hashtags.streetwear"], 2);
    assert.equal(updates[1].$inc["signalCounts.finspo_search_click"], 1);
  } finally {
    GalleryPost.findOne = originalPostFindOne;
    ShadowProfile.findOneAndUpdate = originalProfileFindOneAndUpdate;
  }
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

test("Finspo scores combine creator, Finspo tag, and marketplace tag affinities", () => {
  const profile = {
    finspoAffinities: {
      creatorId: { "creator-1": 30 },
      hashtags: { streetwear: 20 },
    },
    itemAffinities: {
      hashtags: { streetwear: 10 },
    },
  };

  assert.equal(scoreFinspo(profile, {
    tags: ["streetwear"],
    userId: "creator-1",
  }), 60);
});

test("Finspo pages contain 25 personalized and 25 newest posts in stable random order", () => {
  const candidates = items("post", 120);
  const input = {
    fresh: candidates,
    newCount: FINSPO_FEED.NEW_COUNT,
    pageSize: FINSPO_FEED.PAGE_SIZE,
    personalized: [...candidates].reverse(),
    personalizedCount: FINSPO_FEED.PERSONALIZED_COUNT,
    seed: "finspo-session",
  };
  const first = composeFinspoFeed(input);
  const second = composeFinspoFeed(input);

  assert.deepEqual(first, second);
  assert.equal(first.results.length, 120);
  assert.deepEqual(first.allocations[0], { fallback: 0, new: 25, personalized: 25 });
  assert.deepEqual(first.allocations[1], { fallback: 0, new: 25, personalized: 25 });
  assert.equal(new Set(first.results.map((item) => item._id)).size, 120);
  assert.notDeepEqual(first.results.slice(0, 50), [...candidates].reverse().slice(0, 50));
});

test("the final Finspo page keeps a balanced split without duplicates", () => {
  const candidates = items("post", 60);
  const composed = composeFinspoFeed({
    fresh: candidates,
    newCount: FINSPO_FEED.NEW_COUNT,
    pageSize: FINSPO_FEED.PAGE_SIZE,
    personalized: [...candidates].reverse(),
    personalizedCount: FINSPO_FEED.PERSONALIZED_COUNT,
    seed: "short-finspo-session",
  });

  assert.deepEqual(composed.allocations[1], { fallback: 0, new: 5, personalized: 5 });
  assert.equal(new Set(composed.results.map((item) => item._id)).size, 60);
});

test("Finspo account suggestions prioritize inferred creators and randomize fallback", () => {
  assert.equal(FINSPO_ACCOUNT_SUGGESTIONS.CANDIDATE_LIMIT, 500);
  assert.equal(FINSPO_ACCOUNT_SUGGESTIONS.LIMIT, 10);

  const candidates = [
    ...Array.from({ length: 12 }, (_, index) => ({
      creatorId: `fallback-${index}`,
      score: 0,
    })),
    { creatorId: "inferred-lower", score: 12 },
    { creatorId: "inferred-higher", score: 30 },
  ];
  const input = {
    candidates,
    limit: FINSPO_ACCOUNT_SUGGESTIONS.LIMIT,
    seed: "member:day:finspo-account-suggestions",
  };
  const first = selectFinspoAccountCandidates(input);
  const second = selectFinspoAccountCandidates(input);

  assert.deepEqual(first, second);
  assert.equal(first.results.length, 10);
  assert.equal(first.personalized, true);
  assert.equal(first.personalizedCount, 2);
  assert.equal(first.fallbackCount, 8);
  assert.deepEqual(
    first.results.slice(0, 2).map(({ creatorId }) => creatorId),
    ["inferred-higher", "inferred-lower"],
  );
  assert.notDeepEqual(
    first.results.slice(2).map(({ creatorId }) => creatorId),
    candidates.slice(0, 8).map(({ creatorId }) => creatorId),
  );
});

test("Finspo account suggestions cap and deduplicate creator candidates", () => {
  const candidates = [
    ...Array.from({ length: 15 }, (_, index) => ({
      creatorId: `creator-${index}`,
      score: index + 1,
    })),
    { creatorId: "creator-0", score: 100 },
  ];
  const selected = selectFinspoAccountCandidates({
    candidates,
    limit: FINSPO_ACCOUNT_SUGGESTIONS.LIMIT,
    seed: "deduplicated-creators",
  });
  const selectedIds = selected.results.map(({ creatorId }) => creatorId);

  assert.equal(selected.results.length, 10);
  assert.equal(new Set(selectedIds).size, 10);
  assert.equal(selectedIds[0], "creator-0");
  assert.equal(selected.personalizedCount, 10);
  assert.equal(selected.fallbackCount, 0);
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
