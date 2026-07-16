const test = require("node:test");
const assert = require("node:assert/strict");
const Hashtag = require("../src/models/Hashtag");
const {
  collectTagCounts,
  hashtagDiff,
  incrementHashtag,
  isPublishedListing,
  tagsForFinspo,
  tagsForListing,
} = require("../src/services/hashtagService");

test("hashtag records normalize their unique database key", () => {
  const hashtag = new Hashtag({ name: "  ##Street.Wear  " });

  assert.equal(hashtag.name, "streetwear");
  assert.equal(hashtag.postCount, 0);
  assert.equal(hashtag.listingCount, 0);
  assert.equal(hashtag.finspoCount, 0);
});

test("hashtag diffs normalize, deduplicate, and only return actual changes", () => {
  assert.deepEqual(
    hashtagDiff(["#Streetwear", "Y2K", "y2k"], ["streetwear", "Old.Money"]),
    {
      added: ["oldmoney"],
      removed: ["y2k"],
    },
  );
});

test("only published listings contribute to hashtag post counts", () => {
  assert.equal(isPublishedListing({ status: "active" }), true);
  assert.equal(isPublishedListing({ status: "sold" }), true);
  assert.equal(isPublishedListing({ status: "draft" }), false);
  assert.equal(isPublishedListing({ status: "removed" }), false);

  assert.deepEqual(tagsForListing({ status: "active", hashtags: ["#Vintage"] }), ["vintage"]);
  assert.deepEqual(tagsForListing({ status: "draft", hashtags: ["#Vintage"] }), []);
});

test("Finspo posts contribute their normalized tags until deleted", () => {
  assert.deepEqual(tagsForFinspo({ tags: "#Thrifted, OOTD" }), ["thrifted", "ootd"]);
  assert.deepEqual(tagsForFinspo(null), []);
});

test("a concurrent first-use duplicate retries only the unapplied increment", async () => {
  const calls = [];
  const Model = {
    updateOne: async (...args) => {
      calls.push(args);
      if (calls.length === 1) {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  await incrementHashtag("streetwear", "listingCount", new Date(0), Model);

  assert.equal(calls.length, 2);
  assert.equal(calls[0][2].upsert, true);
  assert.equal(calls[1][2], undefined);
  assert.deepEqual(calls[1][1].$inc, { postCount: 1, listingCount: 1 });
  assert.equal(calls[1][1].$setOnInsert, undefined);
});

test("non-duplicate hashtag write failures are not retried", async () => {
  let calls = 0;
  const failure = new Error("database unavailable");
  const Model = {
    updateOne: async () => {
      calls += 1;
      throw failure;
    },
  };

  await assert.rejects(
    incrementHashtag("streetwear", "finspoCount", new Date(0), Model),
    failure,
  );
  assert.equal(calls, 1);
});

test("backfill counts each normalized tag once per post", async () => {
  const documents = [
    { tags: ["#StreetWear", "streetwear", "Y2K"] },
    { tags: ["streetwear"] },
  ];
  const Model = {
    find: () => ({
      select: () => ({
        lean: () => ({
          cursor: async function* cursor() {
            yield* documents;
          },
        }),
      }),
    }),
  };

  const counts = await collectTagCounts(Model, {}, "tags");

  assert.deepEqual(Object.fromEntries(counts), { streetwear: 2, y2k: 1 });
});
