const {
  BARGAIN_ACTIVE_STATUSES,
  BARGAIN_OPEN_STATUSES,
  MAX_BARGAIN_ROUNDS,
} = require("../constants/bargain");
const httpError = require("../utils/httpError");

// Pure bargaining rules. Nothing here touches the database or Mongoose, so the
// whole negotiation state machine stays unit-testable the same way
// `orderWorkflowService` is.

const idValue = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
};

const isOpenStatus = (status) => BARGAIN_OPEN_STATUSES.includes(String(status));

const isActiveStatus = (status) => BARGAIN_ACTIVE_STATUSES.includes(String(status));

// Which side the bargain is currently waiting on. Null once it is settled.
const turnOwner = (bargain) => {
  if (bargain?.status === "awaiting_seller") return "seller";
  if (bargain?.status === "awaiting_buyer") return "buyer";
  return null;
};

const roleFor = (bargain, userId) => {
  const id = idValue(userId);
  if (!id) return null;
  if (idValue(bargain?.buyerId) === id) return "buyer";
  if (idValue(bargain?.sellerId) === id) return "seller";
  return null;
};

const standingOffer = (bargain) => {
  const offers = Array.isArray(bargain?.offers) ? bargain.offers : [];
  return offers.length ? offers[offers.length - 1] : null;
};

// The cap counts offers, not exchanges. Once it is reached the standing offer
// can still be accepted or declined -- it just cannot be countered again.
const canCounter = (bargain) =>
  isOpenStatus(bargain?.status) && Number(bargain?.roundCount || 0) < MAX_BARGAIN_ROUNDS;

const isFinalRound = (bargain) =>
  isOpenStatus(bargain?.status) && Number(bargain?.roundCount || 0) >= MAX_BARGAIN_ROUNDS;

const allowedActionsFor = (bargain, role) => {
  if (!role || role === "system") return [];
  const actions = [];
  if (isOpenStatus(bargain?.status) && turnOwner(bargain) === role) {
    actions.push("accept");
    if (canCounter(bargain)) actions.push("counter");
    actions.push("decline");
  }
  if (isActiveStatus(bargain?.status)) actions.push("cancel");
  return actions;
};

const assertCanAct = (bargain, role, action) => {
  if (!role) throw httpError(403, "You are not part of this bargain");
  if (!isActiveStatus(bargain?.status)) {
    throw httpError(409, "This bargain is already closed");
  }
  if (action === "cancel") return;
  if (!isOpenStatus(bargain?.status)) {
    throw httpError(409, "This bargain is no longer open to offers");
  }
  if (turnOwner(bargain) !== role) {
    throw httpError(409, "It is the other side's turn to respond");
  }
  if (action === "counter" && !canCounter(bargain)) {
    throw httpError(
      409,
      `This bargain has reached its limit of ${MAX_BARGAIN_ROUNDS} offers. Accept or decline the current one.`,
    );
  }
  if (!allowedActionsFor(bargain, role).includes(action)) {
    throw httpError(409, "That action is not available on this bargain");
  }
};

// Money guards. Amounts are integer pesewas like every other price in the app.
const validateOfferAmount = ({ amount, listPrice }) => {
  const value = Number(amount);
  if (!Number.isInteger(value) || value <= 0) {
    throw httpError(422, "Enter a valid offer amount");
  }
  if (Number.isFinite(Number(listPrice)) && value >= Number(listPrice)) {
    throw httpError(422, "Your offer must be lower than the listed price");
  }
  return value;
};

// The seller's floor is private -- we never return the number, only whether the
// buyer's offer fell under it, and only for offers they actually sent.
const isBelowSellerMinimum = (listing, amount) => {
  const minimum = Number(listing?.minAcceptablePrice);
  if (!Number.isFinite(minimum) || minimum <= 0) return false;
  return Number(amount) < minimum;
};

// The single source of truth for what a buyer pays. A bargain only bites when
// it is accepted and unspent; a seller who later drops the list price below the
// agreed price still gets the lower of the two charged.
const resolveLinePrice = (listing, bargain) => {
  const listPrice = Number(listing?.price);
  if (!bargain || bargain.status !== "accepted") return listPrice;
  if (idValue(bargain.listingId) !== idValue(listing?._id)) return listPrice;
  const agreed = Number(bargain.agreedPrice);
  if (!Number.isFinite(agreed) || agreed < 0) return listPrice;
  return Math.min(agreed, listPrice);
};

// Returns the field patch for a transition. The DB layer applies it verbatim so
// `status` and `isActive` can never drift apart.
const nextStateFor = ({ action, amount, bargain, now = new Date(), reason, role }) => {
  switch (action) {
    case "counter":
      return {
        isActive: true,
        roundCount: Number(bargain?.roundCount || 0) + 1,
        status: role === "buyer" ? "awaiting_seller" : "awaiting_buyer",
      };
    case "accept":
      return {
        acceptedAt: now,
        acceptedBy: role,
        agreedPrice: Number(amount),
        isActive: true,
        status: "accepted",
      };
    case "decline":
      return { closedReason: "declined", isActive: false, status: "declined" };
    case "cancel":
      return { closedReason: "cancelled", isActive: false, status: "cancelled" };
    case "close":
      return {
        closedReason: reason || "listing_unavailable",
        isActive: false,
        status: "closed",
      };
    default:
      throw httpError(422, "Unsupported bargain action");
  }
};

module.exports = {
  MAX_BARGAIN_ROUNDS,
  allowedActionsFor,
  assertCanAct,
  canCounter,
  idValue,
  isActiveStatus,
  isBelowSellerMinimum,
  isFinalRound,
  isOpenStatus,
  nextStateFor,
  resolveLinePrice,
  roleFor,
  standingOffer,
  turnOwner,
  validateOfferAmount,
};
