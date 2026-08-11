const Bargain = require("../models/Bargain");
const Listing = require("../models/Listing");
const Message = require("../models/Message");
const httpError = require("../utils/httpError");
const { createNotification } = require("./notificationService");
const { chatUserRoom } = require("../socket/rooms");
const {
  emitChatEvent,
  idValue,
  makeConversationId,
  messagePopulate,
} = require("./chatThreadService");
const {
  allowedActionsFor,
  assertCanAct,
  isBelowSellerMinimum,
  isFinalRound,
  nextStateFor,
  roleFor,
  standingOffer,
  validateOfferAmount,
} = require("./bargainRules");

// Everything that touches the database, the thread, and realtime delivery for a
// negotiation. The rules themselves live in `bargainRules` so they stay pure.

const BARGAIN_LISTING_SELECT = "title images price currency status type quantity bargainingAllowed shopId";

const money = (amount, currency = "GHS") =>
  `${currency} ${(Number(amount || 0) / 100).toFixed(2)}`;

const bargainPopulate = [
  { path: "listingId", select: BARGAIN_LISTING_SELECT },
  { path: "buyerId", select: "name username profilePhoto" },
  { path: "sellerId", select: "name username profilePhoto" },
];

const loadBargain = async (bargainId) => {
  const bargain = await Bargain.findById(bargainId);
  if (!bargain) throw httpError(404, "Bargain not found");
  return bargain;
};

const presentBargain = (bargain, userId) => {
  const role = roleFor(bargain, userId);
  const plain = typeof bargain.toObject === "function" ? bargain.toObject() : { ...bargain };
  return {
    ...plain,
    allowedActions: allowedActionsFor(bargain, role),
    isFinalRound: isFinalRound(bargain),
    viewerRole: role,
  };
};

// The listing must be loadable with its private floor so we can flag low offers
// without ever returning the number itself.
const loadBargainableListing = async (listingId) => {
  const listing = await Listing.findById(listingId)
    .select(`${BARGAIN_LISTING_SELECT} +minAcceptablePrice`)
    .populate("shopId", "ownerId shopName slug");
  if (!listing) throw httpError(404, "Listing not found");
  return listing;
};

const offerMessageContent = ({ action, actorRole, amount, currency, listingTitle }) => {
  const title = listingTitle ? ` for ${listingTitle}` : "";
  switch (action) {
    case "open":
      return `Offered ${money(amount, currency)}${title}`;
    case "counter":
      return `Countered with ${money(amount, currency)}${title}`;
    case "accept":
      return `Accepted ${money(amount, currency)}${title}`;
    case "decline":
      return `Declined the offer${title}`;
    case "cancel":
      return `${actorRole === "buyer" ? "Buyer" : "Seller"} withdrew from the bargain${title}`;
    default:
      return `This bargain is closed${title}`;
  }
};

const writeOfferMessage = async ({
  action,
  actorRole,
  amount,
  bargain,
  listing,
  note,
  previousAmount,
}) => {
  const isSystem = actorRole === "system";
  const buyerId = idValue(bargain.buyerId);
  const sellerId = idValue(bargain.sellerId);
  const senderId = actorRole === "buyer" ? buyerId : sellerId;
  const receiverId = senderId === buyerId ? sellerId : buyerId;
  const currency = bargain.currency || listing?.currency || "GHS";

  const message = await Message.create({
    bargainId: bargain._id,
    content: offerMessageContent({
      action,
      actorRole,
      amount,
      currency,
      listingTitle: listing?.title,
    }),
    conversationId: bargain.conversationId,
    // System cards are informational, so they never bump an unread badge.
    isRead: isSystem,
    listingId: idValue(bargain.listingId),
    offer: {
      action,
      actor: actorRole,
      amount,
      previousAmount,
      round: bargain.roundCount,
    },
    receiverId,
    senderId,
    type: "offer",
  });

  // A listing is always attached, so the thread reveals contact details the
  // same way a product enquiry does.
  await message.populate(messagePopulate("name username profilePhoto phone"));
  return message;
};

const publishBargain = (bargain, message) => {
  const buyerId = idValue(bargain.buyerId);
  const sellerId = idValue(bargain.sellerId);
  const senderId = idValue(message.senderId);
  const receiverId = senderId === buyerId ? sellerId : buyerId;
  const payload = { conversationId: bargain.conversationId, message };

  // Ride the existing chat events so any client that already merges messages
  // shows the card without new plumbing.
  emitChatEvent(chatUserRoom(receiverId), "new-message", payload);
  emitChatEvent(chatUserRoom(senderId), "message-confirmed", payload);

  // `allowedActions` is relative to who is looking, so each side gets its own
  // copy -- a shared payload would blank out the buttons for both.
  for (const userId of [buyerId, sellerId]) {
    if (!userId) continue;
    emitChatEvent(chatUserRoom(userId), "bargain-updated", {
      bargain: presentBargain(bargain, userId),
      conversationId: bargain.conversationId,
      message,
    });
  }
};

const notifyBargain = async ({ action, actorRole, amount, bargain, listing }) => {
  const buyerId = idValue(bargain.buyerId);
  const sellerId = idValue(bargain.sellerId);
  const recipientId = actorRole === "buyer" ? sellerId : buyerId;
  const currency = bargain.currency || listing?.currency || "GHS";
  const label = listing?.title || "your listing";

  // Offers and counters land as chat notifications, which the bell feed filters
  // out; the outcomes that decide whether a deal exists use "order" so they are
  // visible there.
  const copy = {
    accept: {
      body: `${actorRole === "seller" ? "The seller" : "The buyer"} accepted ${money(amount, currency)} for ${label}.`,
      title: "Bargain accepted",
      type: "order",
    },
    cancel: {
      body: `${actorRole === "buyer" ? "The buyer" : "The seller"} withdrew from the bargain on ${label}.`,
      title: "Bargain withdrawn",
      type: "order",
    },
    close: {
      body: `The bargain on ${label} is closed.`,
      title: "Bargain closed",
      type: "order",
    },
    counter: {
      body: `New counter-offer of ${money(amount, currency)} on ${label}.`,
      title: "New counter-offer",
      type: "chat",
    },
    decline: {
      body: `${actorRole === "seller" ? "The seller" : "The buyer"} declined the offer on ${label}.`,
      title: "Bargain declined",
      type: "order",
    },
    open: {
      body: `New offer of ${money(amount, currency)} on ${label}.`,
      title: "New offer",
      type: "chat",
    },
  }[action];
  if (!copy || !recipientId) return;

  try {
    await createNotification({
      body: copy.body,
      eventKey: `bargain:${bargain._id}:${action}:${bargain.roundCount}:${recipientId}`,
      link: `/inbox?conversationId=${encodeURIComponent(bargain.conversationId)}`,
      title: copy.title,
      type: copy.type,
      userId: recipientId,
    });
  } catch {
    // A notification failure must never roll back an accepted price.
  }
};

const openBargain = async ({ amount, listingId, note, userId }) => {
  const listing = await loadBargainableListing(listingId);
  const sellerId = idValue(listing.shopId?.ownerId);

  if (!sellerId) throw httpError(409, "This listing has no active seller");
  if (sellerId === String(userId)) throw httpError(403, "You cannot bargain on your own listing");
  if (listing.status !== "active") throw httpError(409, "This listing is no longer available");
  if (!listing.bargainingAllowed) {
    throw httpError(409, "The seller is not accepting offers on this listing");
  }

  const offerAmount = validateOfferAmount({ amount, listPrice: listing.price });

  const existing = await Bargain.findOne({
    buyerId: userId,
    isActive: true,
    listingId: listing._id,
  });
  if (existing) {
    throw httpError(409, "You already have a bargain running on this listing", {
      bargainId: String(existing._id),
    });
  }

  let bargain;
  try {
    bargain = await Bargain.create({
      buyerId: userId,
      conversationId: makeConversationId({ userA: userId, userB: sellerId }),
      currency: listing.currency || "GHS",
      isActive: true,
      listPriceAtOpen: listing.price,
      listingId: listing._id,
      offers: [{ actor: "buyer", amount: offerAmount, note: note || "" }],
      roundCount: 1,
      sellerId,
      shopId: listing.shopId._id,
      status: "awaiting_seller",
    });
  } catch (error) {
    // Two taps on "Send offer" race through the guard above; the partial unique
    // index is what actually enforces one live bargain per buyer per listing.
    if (error?.code === 11000) {
      throw httpError(409, "You already have a bargain running on this listing");
    }
    throw error;
  }

  const message = await writeOfferMessage({
    action: "open",
    actorRole: "buyer",
    amount: offerAmount,
    bargain,
    listing,
    note,
  });
  bargain.offers[0].messageId = message._id;
  await bargain.save();

  publishBargain(bargain, message);
  await notifyBargain({
    action: "open",
    actorRole: "buyer",
    amount: offerAmount,
    bargain,
    listing,
  });

  await bargain.populate(bargainPopulate);
  return {
    bargain: presentBargain(bargain, userId),
    belowSellerMinimum: isBelowSellerMinimum(listing, offerAmount),
    message,
  };
};

const actOnBargain = async ({ action, amount, bargainId, note, userId }) => {
  const current = await loadBargain(bargainId);
  const role = roleFor(current, userId);
  assertCanAct(current, role, action);

  const listing = await Listing.findById(current.listingId)
    .select(`${BARGAIN_LISTING_SELECT} +minAcceptablePrice`)
    .populate("shopId", "ownerId shopName slug");
  const listPrice = Number(listing?.price ?? current.listPriceAtOpen);
  const previous = standingOffer(current);
  const previousAmount = previous ? Number(previous.amount) : undefined;

  let resolvedAmount;
  if (action === "counter") {
    if (listing && listing.status !== "active") {
      throw httpError(409, "This listing is no longer available");
    }
    resolvedAmount = validateOfferAmount({ amount, listPrice });
  } else if (action === "accept") {
    if (!previous) throw httpError(409, "There is no offer to accept on this bargain");
    resolvedAmount = Number(previous.amount);
  }

  const patch = nextStateFor({
    action,
    amount: resolvedAmount,
    bargain: current,
    role,
  });

  // Guard on the status we validated against so a simultaneous accept/decline
  // from the other side cannot be overwritten.
  const update = { $set: patch };
  if (action === "counter") {
    update.$push = {
      offers: { actor: role, amount: resolvedAmount, note: note || "" },
    };
  }
  const bargain = await Bargain.findOneAndUpdate(
    { _id: current._id, status: current.status },
    update,
    { new: true },
  );
  if (!bargain) throw httpError(409, "This bargain just changed. Reload the conversation.");

  const message = await writeOfferMessage({
    action,
    actorRole: role,
    amount: resolvedAmount,
    bargain,
    listing,
    note,
    previousAmount,
  });
  if (action === "counter") {
    const added = bargain.offers[bargain.offers.length - 1];
    if (added) {
      added.messageId = message._id;
      await bargain.save();
    }
  }

  publishBargain(bargain, message);
  await notifyBargain({
    action,
    actorRole: role,
    amount: resolvedAmount,
    bargain,
    listing,
  });

  await bargain.populate(bargainPopulate);
  return {
    bargain: presentBargain(bargain, userId),
    belowSellerMinimum:
      action === "counter" && role === "buyer"
        ? isBelowSellerMinimum(listing, resolvedAmount)
        : false,
    message,
  };
};

// Called after a listing sells out or is taken down. Deliberately runs outside
// any checkout transaction: it writes chat messages and emits sockets, and a
// failure here must never undo a paid order.
const closeBargainsForListing = async ({ excludeBargainId, listingId, reason }) => {
  const open = await Bargain.find({
    isActive: true,
    listingId,
    ...(excludeBargainId ? { _id: { $ne: excludeBargainId } } : {}),
  });
  if (!open.length) return 0;

  const listing = await Listing.findById(listingId).select(BARGAIN_LISTING_SELECT).lean();

  for (const item of open) {
    const patch = nextStateFor({ action: "close", bargain: item, reason, role: "system" });
    const closed = await Bargain.findOneAndUpdate(
      { _id: item._id, isActive: true },
      { $set: patch },
      { new: true },
    );
    if (!closed) continue;
    try {
      const message = await writeOfferMessage({
        action: "close",
        actorRole: "system",
        bargain: closed,
        listing,
      });
      publishBargain(closed, message);
      await notifyBargain({ action: "close", actorRole: "system", bargain: closed, listing });
    } catch {
      // The bargain is already closed in the database; the card will catch up
      // on the next load even if the realtime notice failed.
    }
  }
  return open.length;
};

// Restock paths hand a buyer's agreed price back when their order never got
// paid for.
const releaseBargainsForOrder = async (orderId) => {
  const consumed = await Bargain.find({ consumedByOrderId: orderId, status: "consumed" });
  for (const bargain of consumed) {
    try {
      await Bargain.updateOne(
        { _id: bargain._id, status: "consumed" },
        {
          $set: { isActive: true, status: "accepted" },
          $unset: { consumedAt: "", consumedByOrderId: "" },
        },
      );
    } catch (error) {
      // The buyer opened a fresh bargain on this listing while the order was
      // pending, so their slot is taken. Leave the old one spent.
      if (error?.code !== 11000) throw error;
    }
  }
  return consumed.length;
};

module.exports = {
  BARGAIN_LISTING_SELECT,
  actOnBargain,
  bargainPopulate,
  closeBargainsForListing,
  loadBargainableListing,
  openBargain,
  presentBargain,
  releaseBargainsForOrder,
};
