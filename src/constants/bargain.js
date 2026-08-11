const BARGAIN_STATUSES = Object.freeze([
  "awaiting_seller",
  "awaiting_buyer",
  "accepted",
  "consumed",
  "declined",
  "cancelled",
  "closed",
]);

// Statuses where one side still owes the other a reply.
const BARGAIN_OPEN_STATUSES = Object.freeze(["awaiting_seller", "awaiting_buyer"]);

// Statuses that hold a slot in the "one live bargain per buyer per listing" rule.
// Accepted counts because the agreed price is still spendable at checkout.
const BARGAIN_ACTIVE_STATUSES = Object.freeze([
  "awaiting_seller",
  "awaiting_buyer",
  "accepted",
]);

const BARGAIN_ACTIONS = Object.freeze([
  "open",
  "counter",
  "accept",
  "decline",
  "cancel",
  "close",
]);

const BARGAIN_ACTORS = Object.freeze(["buyer", "seller", "system"]);

const BARGAIN_CLOSE_REASONS = Object.freeze([
  "round_limit",
  "listing_unavailable",
  "declined",
  "cancelled",
]);

// Every offer and counter across both sides counts toward this cap.
const MAX_BARGAIN_ROUNDS = 10;

module.exports = {
  BARGAIN_ACTIONS,
  BARGAIN_ACTIVE_STATUSES,
  BARGAIN_ACTORS,
  BARGAIN_CLOSE_REASONS,
  BARGAIN_OPEN_STATUSES,
  BARGAIN_STATUSES,
  MAX_BARGAIN_ROUNDS,
};
