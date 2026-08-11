const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_BARGAIN_ROUNDS,
  allowedActionsFor,
  assertCanAct,
  isBelowSellerMinimum,
  isFinalRound,
  nextStateFor,
  resolveLinePrice,
  roleFor,
  standingOffer,
  turnOwner,
  validateOfferAmount,
} = require("../src/services/bargainRules");

const buyerId = "buyer-1";
const sellerId = "seller-1";
const listingId = "listing-1";
const now = new Date("2026-08-10T00:00:00.000Z");

const bargain = (overrides = {}) => ({
  _id: "bargain-1",
  agreedPrice: undefined,
  buyerId,
  listingId,
  listPriceAtOpen: 10000,
  offers: [{ actor: "buyer", amount: 7000 }],
  roundCount: 1,
  sellerId,
  status: "awaiting_seller",
  ...overrides,
});

const listing = (overrides = {}) => ({
  _id: listingId,
  bargainingAllowed: true,
  price: 10000,
  ...overrides,
});

test("roles and turn ownership follow the participants", () => {
  const live = bargain();
  assert.equal(roleFor(live, buyerId), "buyer");
  assert.equal(roleFor(live, sellerId), "seller");
  assert.equal(roleFor(live, "stranger-1"), null);
  assert.equal(roleFor(live, { _id: sellerId }), "seller");

  assert.equal(turnOwner(live), "seller");
  assert.equal(turnOwner(bargain({ status: "awaiting_buyer" })), "buyer");
  assert.equal(turnOwner(bargain({ status: "accepted" })), null);
  assert.equal(standingOffer(live).amount, 7000);
});

test("only the awaited side may respond, and either side may drop out", () => {
  const awaitingSeller = bargain();
  assert.deepEqual(allowedActionsFor(awaitingSeller, "seller"), [
    "accept",
    "counter",
    "decline",
    "cancel",
  ]);
  // The buyer is waiting on a reply -- all they can do is walk away.
  assert.deepEqual(allowedActionsFor(awaitingSeller, "buyer"), ["cancel"]);

  assert.throws(() => assertCanAct(awaitingSeller, "buyer", "accept"), {
    statusCode: 409,
  });
  assert.throws(() => assertCanAct(awaitingSeller, null, "cancel"), {
    statusCode: 403,
  });
  assertCanAct(awaitingSeller, "seller", "accept");
  assertCanAct(awaitingSeller, "buyer", "cancel");
});

test("settled bargains reject every action, including a second cancel", () => {
  for (const status of ["declined", "cancelled", "closed", "consumed"]) {
    const settled = bargain({ status });
    assert.deepEqual(allowedActionsFor(settled, "seller"), []);
    assert.throws(() => assertCanAct(settled, "seller", "cancel"), {
      statusCode: 409,
    });
  }

  // Accepted is still live: the price is spendable, so either side may pull out
  // before checkout, but nobody can keep negotiating.
  const accepted = bargain({ agreedPrice: 7000, status: "accepted" });
  assert.deepEqual(allowedActionsFor(accepted, "buyer"), ["cancel"]);
  assert.throws(() => assertCanAct(accepted, "seller", "counter"), {
    statusCode: 409,
  });
});

test("the round cap blocks further counters but still allows accept or decline", () => {
  const capped = bargain({ roundCount: MAX_BARGAIN_ROUNDS });
  assert.equal(isFinalRound(capped), true);
  assert.deepEqual(allowedActionsFor(capped, "seller"), [
    "accept",
    "decline",
    "cancel",
  ]);
  assert.throws(() => assertCanAct(capped, "seller", "counter"), {
    statusCode: 409,
  });
  assertCanAct(capped, "seller", "accept");

  const oneLeft = bargain({ roundCount: MAX_BARGAIN_ROUNDS - 1 });
  assert.equal(isFinalRound(oneLeft), false);
  assertCanAct(oneLeft, "seller", "counter");
});

test("offer amounts must be whole pesewas below the listed price", () => {
  assert.equal(validateOfferAmount({ amount: 7000, listPrice: 10000 }), 7000);
  assert.equal(validateOfferAmount({ amount: "7000", listPrice: 10000 }), 7000);

  for (const amount of [0, -100, 70.5, "abc", null]) {
    assert.throws(() => validateOfferAmount({ amount, listPrice: 10000 }), {
      statusCode: 422,
    });
  }
  // A bargain is only ever a discount request.
  assert.throws(() => validateOfferAmount({ amount: 10000, listPrice: 10000 }), {
    statusCode: 422,
  });
  assert.throws(() => validateOfferAmount({ amount: 12000, listPrice: 10000 }), {
    statusCode: 422,
  });
});

test("the seller minimum flags low offers without blocking them", () => {
  assert.equal(isBelowSellerMinimum(listing({ minAcceptablePrice: 8000 }), 7000), true);
  assert.equal(isBelowSellerMinimum(listing({ minAcceptablePrice: 8000 }), 8000), false);
  assert.equal(isBelowSellerMinimum(listing({ minAcceptablePrice: 8000 }), 9000), false);
  // No floor set, or a floor the buyer's client never saw.
  assert.equal(isBelowSellerMinimum(listing(), 1), false);
  assert.equal(isBelowSellerMinimum(listing({ minAcceptablePrice: 0 }), 1), false);
});

test("checkout resolves the buyer's price from the bargain, never the request", () => {
  const item = listing();
  assert.equal(resolveLinePrice(item, null), 10000);
  assert.equal(resolveLinePrice(item, bargain()), 10000);
  assert.equal(resolveLinePrice(item, bargain({ status: "declined" })), 10000);
  assert.equal(
    resolveLinePrice(item, bargain({ agreedPrice: 7000, status: "consumed" })),
    10000,
  );
  assert.equal(
    resolveLinePrice(item, bargain({ agreedPrice: 7000, status: "accepted" })),
    7000,
  );

  // A bargain for a different listing must never bleed across the cart.
  assert.equal(
    resolveLinePrice(
      item,
      bargain({ agreedPrice: 7000, listingId: "listing-2", status: "accepted" }),
    ),
    10000,
  );

  // If the seller later undercuts the agreed price, the buyer pays the lower one.
  assert.equal(
    resolveLinePrice(
      listing({ price: 6000 }),
      bargain({ agreedPrice: 7000, status: "accepted" }),
    ),
    6000,
  );
});

test("transitions always move status and isActive together", () => {
  const live = bargain();
  assert.deepEqual(nextStateFor({ action: "counter", bargain: live, role: "seller" }), {
    isActive: true,
    roundCount: 2,
    status: "awaiting_buyer",
  });
  assert.deepEqual(nextStateFor({ action: "counter", bargain: live, role: "buyer" }), {
    isActive: true,
    roundCount: 2,
    status: "awaiting_seller",
  });
  assert.deepEqual(
    nextStateFor({ action: "accept", amount: 7000, bargain: live, now, role: "seller" }),
    {
      acceptedAt: now,
      acceptedBy: "seller",
      agreedPrice: 7000,
      isActive: true,
      status: "accepted",
    },
  );

  for (const [action, status] of [
    ["decline", "declined"],
    ["cancel", "cancelled"],
    ["close", "closed"],
  ]) {
    const patch = nextStateFor({ action, bargain: live, role: "buyer" });
    assert.equal(patch.status, status);
    assert.equal(patch.isActive, false, `${action} must free the buyer's slot`);
    assert.ok(patch.closedReason);
  }

  assert.equal(
    nextStateFor({ action: "close", bargain: live, reason: "round_limit", role: "buyer" })
      .closedReason,
    "round_limit",
  );
  assert.throws(() => nextStateFor({ action: "nope", bargain: live, role: "buyer" }), {
    statusCode: 422,
  });
});
