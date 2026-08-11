const test = require("node:test");
const assert = require("node:assert/strict");
const { checkoutRequestHashFor } = require("../src/controllers/orderController");

const listingA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const listingB = "bbbbbbbbbbbbbbbbbbbbbbbb";

const request = (overrides = {}) => ({
  deliveryByShop: {
    "cccccccccccccccccccccccc": { method: "shop_pickup" },
  },
  items: [{ listingId: listingA, quantity: 1 }],
  paymentMethod: "paystack",
  ...overrides,
});

test("a checkout with no bargain hashes exactly as it did before the feature", () => {
  // Orders placed before bargaining stored a hash built without the bargains
  // key. Replaying one of those keys must not read as a different request.
  assert.equal(
    checkoutRequestHashFor(request()),
    checkoutRequestHashFor(request({ bargains: [] })),
  );
});

test("the negotiated price is part of the checkout's identity", () => {
  const plain = checkoutRequestHashFor(request());
  const negotiated = checkoutRequestHashFor(
    request({ bargains: [{ amount: 7000, listingId: listingA }] }),
  );
  const renegotiated = checkoutRequestHashFor(
    request({ bargains: [{ amount: 6500, listingId: listingA }] }),
  );

  assert.notEqual(plain, negotiated);
  // Replaying an old Idempotency-Key after agreeing a new price must 409
  // rather than quietly reuse the stale one.
  assert.notEqual(negotiated, renegotiated);
});

test("bargain order and populated listing refs do not change the hash", () => {
  const ordered = checkoutRequestHashFor(
    request({
      bargains: [
        { amount: 7000, listingId: listingA },
        { amount: 4000, listingId: listingB },
      ],
      items: [
        { listingId: listingA, quantity: 1 },
        { listingId: listingB, quantity: 1 },
      ],
    }),
  );
  const reversedAndPopulated = checkoutRequestHashFor(
    request({
      bargains: [
        { amount: 4000, listingId: { _id: listingB } },
        { amount: 7000, listingId: { _id: listingA } },
      ],
      items: [
        { listingId: listingB, quantity: 1 },
        { listingId: listingA, quantity: 1 },
      ],
    }),
  );

  assert.equal(ordered, reversedAndPopulated);
});
