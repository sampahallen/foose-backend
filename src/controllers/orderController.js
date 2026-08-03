const crypto = require("crypto");
const mongoose = require("mongoose");
const DigiShop = require("../models/DigiShop");
const Listing = require("../models/Listing");
const Order = require("../models/Order");
const OrderEvent = require("../models/OrderEvent");
const OrderReport = require("../models/OrderReport");
const PaymentTransaction = require("../models/PaymentTransaction");
const User = require("../models/User");
const {
  LATE_CHARGE_WATCH_MS,
  ORDER_REPORT_CATEGORIES,
  ORDER_REPORT_OUTCOMES,
} = require("../constants/orderLifecycle");
const { ROLE_GROUPS, hasAnyRole } = require("../constants/roles");
const { createPrivateDownloadUrl } = require("../config/s3");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { invalidate } = require("../utils/cache");
const {
  AIRPORT_COURIER,
  STATION_PICKUP_COMPANIES,
} = require("../constants/delivery");
const {
  destinationsForOrigin: twoMExpressDestinationsForOrigin,
  isValidDestination: isValidTwoMExpressDestination,
} = require("../constants/twoMExpressRoutes");
const {
  destinationsForOrigin: intercityStcDestinationsForOrigin,
  isValidDestination: isValidIntercityStcDestination,
} = require("../constants/intercityStcRoutes");
const {
  destinationsForOrigin: vipJeounDestinationsForOrigin,
  isValidDestination: isValidVipJeounDestination,
} = require("../constants/vipJeounRoutes");
const {
  initializeTransaction,
  toInlinePayment,
  verifyTransaction,
} = require("../services/paystackService");
const { awardPurchaseForOrder } = require("../services/recommendationService");
const {
  runSearchSync,
  syncListingSearchDocument,
} = require("../services/searchIndexService");
const {
  cancelCashPickup,
  closeNoAction,
  completeCashPickup,
  confirmCollection,
  confirmReceipt,
  dispatchOrder,
  loadParticipantOrder,
  markPaymentTransactionPaid,
  markPickupReady,
  notifyLifecycleEvent,
  participantPopulate,
  releaseUnclaimedPickup,
  submitReport,
  withTransaction,
} = require("../services/orderLifecycleService");
const { presentOrder } = require("../services/orderWorkflowService");

const asTrimmed = (value, max = 500) => String(value || "").trim().slice(0, max);

const idempotencyKeyFor = (req) =>
  asTrimmed(req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"], 120);

const parseAffectedItems = (value) => {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Comma-separated multipart values are supported for lightweight clients.
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const resolveDestination = (req, entry = {}) => {
  const destination = entry.destination || {};
  const legacyAddress = entry.address || {};

  if (
    entry.method !== "shop_pickup" &&
    !entry.destination &&
    entry.address &&
    !asTrimmed(legacyAddress.street)
  ) {
    throw httpError(422, "Destination details are required for this delivery method");
  }

  return {
    preferredTerminal: asTrimmed(destination.preferredTerminal, 240),
    recipientName: asTrimmed(
      destination.recipientName || req.currentUser?.name || req.user?.username,
      160,
    ),
    recipientPhone: asTrimmed(
      destination.recipientPhone || req.currentUser?.phone || req.user?.phone,
      40,
    ),
    region: asTrimmed(destination.region || legacyAddress.region, 120),
    town: asTrimmed(destination.town || legacyAddress.city || legacyAddress.street, 160),
  };
};

const validateDestination = (destination) => {
  if (!destination.recipientName) throw httpError(422, "Recipient name is required");
  if (!destination.recipientPhone) throw httpError(422, "Recipient phone is required");
  if (!destination.region) throw httpError(422, "Destination region is required");
  if (!destination.town) throw httpError(422, "Destination town is required");
};

const normalizedCheckoutDestination = (destination = {}) => ({
  preferredTerminal: asTrimmed(destination.preferredTerminal, 240),
  recipientName: asTrimmed(
    destination.recipientName || destination.recipient?.name,
    160,
  ),
  recipientPhone: asTrimmed(
    destination.recipientPhone || destination.recipient?.phone,
    40,
  ),
  region: asTrimmed(destination.region, 120),
  town: asTrimmed(destination.town, 160),
});

const checkoutRequestHashFor = ({ deliveryByShop, items, paymentMethod }) => {
  const quantities = new Map();
  for (const item of items || []) {
    const listingId = String(
      item.listingId?._id || item.listingId || "",
    ).toLowerCase();
    if (!listingId) continue;
    quantities.set(
      listingId,
      (quantities.get(listingId) || 0) + Number(item.quantity || 1),
    );
  }
  const normalizedDeliveryByShop = Object.entries(deliveryByShop || {})
    .map(([shopId, entry]) => [
      String(shopId).toLowerCase(),
      {
        company: entry?.company || null,
        destination:
          entry?.method !== "shop_pickup"
            ? normalizedCheckoutDestination(entry?.destination)
            : null,
        method: entry?.method || null,
      },
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  const canonical = {
    deliveryByShop: normalizedDeliveryByShop,
    items: [...quantities.entries()]
      .map(([listingId, quantity]) => ({ listingId, quantity }))
      .sort((left, right) => left.listingId.localeCompare(right.listingId)),
    paymentMethod,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
};

const syncListings = async (ids, reason) => {
  await Promise.allSettled(
    [...new Set(ids.map(String))].map((listingId) =>
      runSearchSync(`listing:${listingId}:${reason}`, () =>
        syncListingSearchDocument(listingId)),
    ),
  );
};

const presentOrders = (orders, userId, now = new Date()) =>
  orders.map((order) => presentOrder(order, userId, now));

const groupOrderLines = (orderLines) => {
  const groups = new Map();
  for (const line of orderLines) {
    const shopId = String(line.listing.shopId._id);
    if (!groups.has(shopId)) {
      groups.set(shopId, {
        lines: [],
        shop: line.listing.shopId,
      });
    }
    groups.get(shopId).lines.push(line);
  }
  return [...groups.values()];
};

const rollbackUnpaidOrders = async (orderIds, now = new Date()) => {
  const restored = await withTransaction(async (session) => {
    const orders = await Order.find({
      _id: { $in: orderIds },
      fulfillmentStatus: "awaiting_seller",
      settlementStatus: "payment_pending",
    }).session(session);

    const claimedOrders = [];
    for (const order of orders) {
      const claimed = await Order.findOneAndUpdate(
        {
          _id: order._id,
          fulfillmentStatus: "awaiting_seller",
          inventoryRestoredAt: null,
          settlementStatus: "payment_pending",
        },
        {
          $set: {
            cancelledAt: now,
            checkoutCancelledAt: now,
            escrowStatus: "not_held",
            fulfillmentStatus: "cancelled",
            inventoryRestoredAt: now,
            settlementStatus: "void",
            status: "cancelled",
          },
          $unset: { workflowDeadlineAt: 1 },
        },
        { new: true, session },
      );
      if (!claimed) continue;
      for (const item of claimed.items) {
        if (!item.listingId) {
          throw httpError(
            409,
            `Inventory restoration for order ${claimed._id} requires operations attention`,
          );
        }
        const inventoryUpdate = await Listing.updateOne(
          { _id: item.listingId },
          [
            {
              $set: {
                quantity: {
                  $add: [
                    { $ifNull: ["$quantity", 0] },
                    Math.max(Number(item.quantity || 1), 1),
                  ],
                },
                status: {
                  $cond: [
                    { $eq: ["$status", "sold"] },
                    "active",
                    "$status",
                  ],
                },
              },
            },
          ],
          { session },
        );
        if (
          Number(
            inventoryUpdate.matchedCount ?? inventoryUpdate.modifiedCount ?? 0,
          ) !== 1
        ) {
          throw httpError(
            409,
            `Inventory restoration for order ${claimed._id} could not find listing ${item.listingId}`,
          );
        }
      }
      claimedOrders.push(claimed);
    }
    const references = [...new Set(orders.map((order) => order.paymentRef).filter(Boolean))];
    for (const reference of references) {
      const referenceOrders = claimedOrders.filter(
        (order) => order.paymentRef === reference,
      );
      if (!referenceOrders.length) continue;
      const paymentQuery = PaymentTransaction.findOne({
        providerReference: reference,
      });
      let payment = session
        ? await paymentQuery.session(session)
        : await paymentQuery;
      if (payment) {
        const paymentCancellation = await PaymentTransaction.updateOne(
          {
            _id: payment._id,
            status: { $in: ["pending", "processing", "cancelled"] },
          },
          {
            $set: {
              cancelledAt: now,
              lateChargeWatchUntil: new Date(
                now.getTime() + LATE_CHARGE_WATCH_MS,
              ),
              status: "cancelled",
            },
          },
          session ? { session } : undefined,
        );
        if (
          Number(
            paymentCancellation.matchedCount ??
              paymentCancellation.modifiedCount ??
              0,
          ) !== 1
        ) {
          throw httpError(
            409,
            "Payment completed before interrupted checkout recovery could cancel it",
          );
        }
      } else {
        [payment] = await PaymentTransaction.create(
          [
            {
              amount: referenceOrders.reduce(
                (total, order) => total + Number(order.totalAmount),
                0,
              ),
              buyerId: referenceOrders[0].buyerId,
              cancelledAt: now,
              currency: referenceOrders[0].currency || "GHS",
              lateChargeWatchUntil: new Date(
                now.getTime() + LATE_CHARGE_WATCH_MS,
              ),
              orderIds: referenceOrders.map((order) => order._id),
              providerReference: reference,
              status: "cancelled",
            },
          ],
          session ? { session } : undefined,
        );
      }
      await Order.updateMany(
        { _id: { $in: referenceOrders.map((order) => order._id) } },
        { $set: { paymentTransactionId: payment._id } },
        session ? { session } : undefined,
      );
    }
    return claimedOrders;
  });
  await syncListings(
    restored.flatMap((order) => order.items.map((item) => item.listingId)),
    "checkout-rollback",
  );
};

const checkoutProviderReference = (buyerId, checkoutKey) =>
  `foose-${crypto
    .createHash("sha256")
    .update(`${buyerId}:${checkoutKey}`)
    .digest("hex")
    .slice(0, 48)}`;

const initializeReservedOrders = async ({
  buyer,
  callbackUrl,
  checkoutKey,
  currency,
  orders,
}) => {
  const orderIds = orders.map((order) => order._id);
  const anchorId = [...orderIds].sort((left, right) =>
    String(left).localeCompare(String(right)))[0];
  const token = crypto.randomUUID();
  const now = new Date();
  const claimed = await Order.findOneAndUpdate(
    {
      _id: anchorId,
      paymentTransactionId: null,
      settlementStatus: "payment_pending",
      $or: [
        { "checkoutInitializationClaim.until": { $exists: false } },
        { "checkoutInitializationClaim.until": { $lte: now } },
      ],
    },
    {
      $set: {
        checkoutInitializationClaim: {
          token,
          until: new Date(now.getTime() + 2 * 60 * 1000),
        },
      },
    },
    { new: true },
  ).select("+checkoutInitializationClaim.token");
  if (!claimed) {
    throw httpError(409, "This checkout is already being initialized; retry shortly");
  }

  const reference = checkoutProviderReference(buyer._id, checkoutKey);
  await Order.updateMany(
    {
      _id: { $in: orderIds },
      paymentTransactionId: null,
      settlementStatus: "payment_pending",
    },
    { $set: { paymentRef: reference } },
  );

  let providerTransaction;
  try {
    providerTransaction = await initializeTransaction({
      amount: orders.reduce((total, order) => total + Number(order.totalAmount), 0),
      callbackUrl,
      currency,
      email: buyer.email,
      metadata: {
        buyerId: String(buyer._id),
        checkoutIdempotencyKey: checkoutKey,
        orderIds: orderIds.map(String),
      },
      reference,
    });
  } catch (error) {
    await Order.updateOne(
      { _id: anchorId, "checkoutInitializationClaim.token": token },
      { $unset: { checkoutInitializationClaim: 1 } },
    );
    throw error;
  }

  let payment;
  try {
    payment = await PaymentTransaction.create({
      amount: orders.reduce((total, order) => total + Number(order.totalAmount), 0),
      buyerId: buyer._id,
      checkoutIdempotencyKey: checkoutKey,
      currency,
      orderIds,
      providerMetadata: providerTransaction,
      providerReference: reference,
      status: "pending",
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    payment = await PaymentTransaction.findOne({ providerReference: reference });
    if (!payment) throw error;
  }

  await Order.updateMany(
    { _id: { $in: orderIds }, settlementStatus: "payment_pending" },
    {
      $set: {
        paymentRef: reference,
        paymentTransactionId: payment._id,
      },
      $unset: { checkoutInitializationClaim: 1 },
    },
  );
  return { payment, providerTransaction };
};

exports.getCheckoutDeliveryOptions = asyncHandler(async (req, res) => {
  const shopIds = String(req.query.shopIds || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^[a-f0-9]{24}$/i.test(id));
  if (!shopIds.length) throw httpError(422, "At least one shopId is required");

  const shops = await DigiShop.find({ _id: { $in: shopIds } }).select("shopName location");

  const stopOption = (stop) => ({
    label: stop.terminal ? `${stop.town} (${stop.terminal})` : stop.town,
    region: stop.region,
    terminal: stop.terminal,
    town: stop.town,
  });

  const options = shops.map((shop) => {
    const twoMExpressDestinations = twoMExpressDestinationsForOrigin(shop.location);
    const intercityStcDestinations = intercityStcDestinationsForOrigin(shop.location);
    const vipJeounDestinations = vipJeounDestinationsForOrigin(shop.location);
    return {
      intercityStc: {
        destinations: intercityStcDestinations.map(stopOption),
        eligible: intercityStcDestinations.length > 0,
      },
      location: { city: shop.location?.city || "", region: shop.location?.region || "" },
      shopId: shop._id,
      shopName: shop.shopName,
      twoMExpress: {
        destinations: twoMExpressDestinations.map(stopOption),
        eligible: twoMExpressDestinations.length > 0,
      },
      vipJeoun: {
        destinations: vipJeounDestinations.map(stopOption),
        eligible: vipJeounDestinations.length > 0,
      },
    };
  });

  return success(res, { shops: options }, "Checkout delivery options loaded");
});

exports.placeOrder = asyncHandler(async (req, res) => {
  const requestedItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!requestedItems.length) throw httpError(422, "At least one order item is required");

  const deliveryByShop =
    req.body.deliveryByShop && typeof req.body.deliveryByShop === "object"
      ? req.body.deliveryByShop
      : {};
  const shopEntryIds = Object.keys(deliveryByShop);
  if (!shopEntryIds.length) {
    throw httpError(422, "Delivery details are required for every seller in this checkout");
  }
  const requestedPaymentMethod = req.body.paymentMethod || "paystack";
  const paymentMethod =
    requestedPaymentMethod === "paystack_mock" ? "paystack" : requestedPaymentMethod;

  const resolvedDeliveryByShop = {};
  for (const shopId of shopEntryIds) {
    const entry = deliveryByShop[shopId] || {};
    const method = entry.method || "station_pickup";
    const destination = resolveDestination(req, entry);
    if (method !== "shop_pickup") validateDestination(destination);

    let company = "";
    if (method === "station_pickup") {
      company = asTrimmed(entry.company, 160);
      if (!STATION_PICKUP_COMPANIES.includes(company)) {
        throw httpError(422, "Choose a valid bus transit company");
      }
    } else if (method === "airport_to_airport") {
      company = AIRPORT_COURIER;
    }

    resolvedDeliveryByShop[shopId] = {
      address: entry.address,
      company,
      destination,
      method,
    };
  }

  if (
    paymentMethod === "cash_on_pickup" &&
    Object.values(resolvedDeliveryByShop).some((entry) => entry.method !== "shop_pickup")
  ) {
    throw httpError(
      400,
      "Cash on pickup is only available when every seller in the cart uses shop pickup",
    );
  }

  const quantityByListing = new Map();
  for (const item of requestedItems) {
    const listingId = String(item.listingId || "").trim().toLowerCase();
    if (!listingId) throw httpError(422, "Every order item needs a listingId");
    const quantity = Number(item.quantity || 1);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw httpError(422, "Order quantities must be positive whole numbers");
    }
    quantityByListing.set(listingId, (quantityByListing.get(listingId) || 0) + quantity);
  }
  const listingIds = [...quantityByListing.keys()];
  const checkoutRequestHash = checkoutRequestHashFor({
    deliveryByShop: resolvedDeliveryByShop,
    items: [...quantityByListing.entries()].map(([listingId, quantity]) => ({
      listingId,
      quantity,
    })),
    paymentMethod,
  });

  const checkoutIdempotencyKey =
    idempotencyKeyFor(req) || asTrimmed(req.body.checkoutIdempotencyKey, 120);
  if (!checkoutIdempotencyKey) {
    throw httpError(
      422,
      "An Idempotency-Key header is required to place an order safely",
    );
  }
  if (checkoutIdempotencyKey) {
    const existing = await Order.find({
      buyerId: req.user.id,
      checkoutIdempotencyKey,
    })
      .select(
        "+checkoutAnchor +checkoutInitializationClaim.token +checkoutRequestHash",
      )
      .populate(participantPopulate);
    if (existing.length) {
      if (existing.every((order) => order.checkoutCancelledAt)) {
        throw httpError(
          409,
          "This checkout key was cancelled; start the new checkout with a new Idempotency-Key",
        );
      }
      const persistedHashes = [
        ...new Set(
          existing.map((order) => order.checkoutRequestHash).filter(Boolean),
        ),
      ];
      const existingRequestHash =
        persistedHashes[0] ||
        checkoutRequestHashFor({
          deliveryByShop: Object.fromEntries(
            existing.map((order) => [
              String(order.shopId?._id || order.shopId),
              {
                company: order.delivery?.company,
                destination:
                  order.delivery?.destination || {
                    region: order.delivery?.address?.region,
                    town:
                      order.delivery?.address?.city ||
                      order.delivery?.address?.street,
                  },
                method: order.delivery?.method,
              },
            ]),
          ),
          items: existing.flatMap((order) => order.items || []),
          paymentMethod: existing[0].paymentMethod,
        });
      if (
        persistedHashes.length > 1 ||
        existingRequestHash !== checkoutRequestHash
      ) {
        throw httpError(
          409,
          "This idempotency key belongs to a different checkout request",
        );
      }
      if (existing.some((order) => !order.checkoutRequestHash)) {
        await Order.updateMany(
          {
            _id: { $in: existing.map((order) => order._id) },
            checkoutRequestHash: { $exists: false },
          },
          { $set: { checkoutRequestHash } },
        );
      }
      const existingPaymentMethod = existing[0].paymentMethod;
      if (
        existingPaymentMethod !== paymentMethod ||
        existing[0].delivery?.method !== method
      ) {
        throw httpError(
          409,
          "This idempotency key belongs to a different checkout request",
        );
      }
      let payment = existing[0].paymentTransactionId
        ? await PaymentTransaction.findById(existing[0].paymentTransactionId)
            .select("+providerMetadata +checkoutIdempotencyKey")
        : null;
      if (!payment && existing[0].paymentRef) {
        payment = await PaymentTransaction.findOne({
          providerReference: existing[0].paymentRef,
        }).select("+providerMetadata +checkoutIdempotencyKey");
        if (payment) {
          await Order.updateMany(
            { _id: { $in: existing.map((order) => order._id) } },
            {
              $set: { paymentTransactionId: payment._id },
              $unset: { checkoutInitializationClaim: 1 },
            },
          );
        }
      }
      let providerMetadata = payment?.providerMetadata || {};

      if (!payment && existingPaymentMethod !== "cash_on_pickup") {
        const claimUntil = existing[0].checkoutInitializationClaim?.until;
        if (claimUntil && new Date(claimUntil).getTime() > Date.now()) {
          throw httpError(409, "This checkout is already being initialized; retry shortly");
        }

        if (existing[0].paymentRef) {
          let verified;
          try {
            verified = await verifyTransaction(existing[0].paymentRef);
          } catch (error) {
            if (error.response?.status === 404) {
              await rollbackUnpaidOrders(existing.map((order) => order._id));
              throw httpError(
                409,
                "The interrupted checkout was released. Start a new checkout.",
              );
            }
            throw httpError(
              503,
              "Payment recovery is temporarily unavailable; retry with the same key",
            );
          }

          if (verified.status !== "success") {
            await rollbackUnpaidOrders(existing.map((order) => order._id));
            throw httpError(
              409,
              "The interrupted checkout was released. Start a new checkout.",
            );
          }
          payment = await PaymentTransaction.create({
            amount: existing.reduce(
              (total, order) => total + Number(order.totalAmount),
              0,
            ),
            buyerId: req.user.id,
            checkoutIdempotencyKey,
            currency: existing[0].currency || "GHS",
            orderIds: existing.map((order) => order._id),
            providerMetadata: verified,
            providerReference: existing[0].paymentRef,
            status: "pending",
          });
          await Order.updateMany(
            { _id: { $in: existing.map((order) => order._id) } },
            {
              $set: { paymentTransactionId: payment._id },
              $unset: { checkoutInitializationClaim: 1 },
            },
          );
          await markPaymentTransactionPaid({
            buyerId: req.user.id,
            providerReference: existing[0].paymentRef,
            providerTransaction: verified,
          });
          payment = await PaymentTransaction.findById(payment._id).select(
            "+providerMetadata +checkoutIdempotencyKey",
          );
          providerMetadata = verified;
        } else {
          const existingBuyer = await User.findById(req.user.id);
          const initialized = await initializeReservedOrders({
            buyer: existingBuyer,
            callbackUrl: req.body.callbackUrl,
            checkoutKey: checkoutIdempotencyKey,
            currency: existing[0].currency || "GHS",
            orders: existing,
          });
          payment = initialized.payment;
          providerMetadata = initialized.providerTransaction;
        }
      }

      const currentOrders = await Order.find({
        _id: { $in: existing.map((order) => order._id) },
      }).populate(participantPopulate);
      return success(
        res,
        {
          checkoutIdempotencyKey,
          order: presentOrder(currentOrders[0], req.user.id),
          orders: presentOrders(currentOrders, req.user.id),
          payment:
            payment && providerMetadata.access_code
              ? toInlinePayment(providerMetadata)
              : {
                  mode:
                    existingPaymentMethod === "cash_on_pickup" ? "pickup" : "pending",
                  provider:
                    existingPaymentMethod === "cash_on_pickup" ? "cash" : "paystack",
                  reference: payment?.providerReference,
                  status: payment?.status || "pending",
                },
        },
        "Checkout already created",
        200,
      );
    }
  }

  const listings = await Listing.find({
    _id: { $in: listingIds },
    status: "active",
  }).populate("shopId", "ownerId shopName slug location");
  if (listings.length !== listingIds.length) {
    throw httpError(400, "One or more listings are unavailable");
  }
  if (listings.some((listing) => String(listing.shopId?.ownerId) === String(req.user.id))) {
    throw httpError(403, "You cannot purchase your own listing");
  }

  const currencies = new Set(listings.map((listing) => String(listing.currency || "GHS")));
  if (currencies.size !== 1) {
    throw httpError(400, "All items in one checkout must use the same currency");
  }
  const orderLines = listings.map((listing) => {
    const quantity = quantityByListing.get(String(listing._id));
    if (listing.type === "retail" && quantity !== 1) {
      throw httpError(400, `${listing.title} is a single-item retail listing`);
    }
    if (listing.type === "wholesale" && listing.bulkMinQty && quantity < listing.bulkMinQty) {
      throw httpError(
        400,
        `${listing.title} requires a minimum order quantity of ${listing.bulkMinQty}`,
      );
    }
    if (Number(listing.quantity) < quantity) {
      throw httpError(409, `${listing.title} does not have enough stock`);
    }
    return {
      listing,
      quantity,
      subtotalAmount: Number(listing.price) * quantity,
    };
  });

  const groups = groupOrderLines(orderLines);
  for (const group of groups) {
    const delivery = resolvedDeliveryByShop[String(group.shop._id)];
    if (!delivery) {
      throw httpError(
        422,
        `Delivery details are missing for ${group.shop.shopName || "one of the sellers"} in this checkout`,
      );
    }
    if (delivery.method === "station_pickup" && delivery.company === "2M Express") {
      if (!isValidTwoMExpressDestination(group.shop.location, delivery.destination)) {
        throw httpError(
          422,
          `2M Express does not serve this route for ${group.shop.shopName || "this seller"}`,
        );
      }
    } else if (delivery.method === "station_pickup" && delivery.company === "Intercity STC") {
      if (!isValidIntercityStcDestination(group.shop.location, delivery.destination)) {
        throw httpError(
          422,
          `Intercity STC does not serve this route for ${group.shop.shopName || "this seller"}`,
        );
      }
    } else if (delivery.method === "station_pickup" && delivery.company === "VIP Jeoun") {
      if (!isValidVipJeounDestination(group.shop.location, delivery.destination)) {
        throw httpError(
          422,
          `VIP Jeoun does not serve this route for ${group.shop.shopName || "this seller"}`,
        );
      }
    }
  }
  const buyer = await User.findById(req.user.id);
  if (!buyer) throw httpError(401, "Buyer account is unavailable");
  const now = new Date();
  const checkoutKey = checkoutIdempotencyKey || crypto.randomUUID();

  const createdOrders = await withTransaction(async (session) => {
    for (const line of orderLines) {
      const reserved = await Listing.findOneAndUpdate(
        {
          _id: line.listing._id,
          quantity: { $gte: line.quantity },
          status: "active",
        },
        { $inc: { quantity: -line.quantity } },
        { new: true, session },
      );
      if (!reserved) {
        throw httpError(409, `${line.listing.title} was just purchased by another buyer`);
      }
      if (reserved.type === "retail" || Number(reserved.quantity) === 0) {
        await Listing.updateOne(
          { _id: reserved._id },
          { $set: { quantity: 0, status: "sold" } },
          { session },
        );
      }
    }

    const documents = groups.map((group, groupIndex) => {
      const delivery = resolvedDeliveryByShop[String(group.shop._id)];
      const subtotalAmount = group.lines.reduce(
        (total, line) => total + line.subtotalAmount,
        0,
      );
      const deliveryFee = 0;
      return {
        buyerId: req.user.id,
        checkoutAnchor: groupIndex === 0,
        checkoutIdempotencyKey: checkoutKey,
        checkoutRequestHash,
        currency: [...currencies][0],
        delivery: {
          address: delivery.address,
          company: delivery.company || undefined,
          destination: delivery.method !== "shop_pickup" ? delivery.destination : undefined,
          fee: deliveryFee,
          method: delivery.method,
        },
        deliveryFee,
        escrowStatus: "not_held",
        fulfillmentStatus: "awaiting_seller",
        items: group.lines.map((line) => ({
          listingId: line.listing._id,
          price: line.listing.price,
          quantity: line.quantity,
          title: line.listing.title,
        })),
        paymentMethod,
        paymentStatus: paymentMethod === "cash_on_pickup" ? "cash_on_pickup" : "unpaid",
        settlementExplanation:
          paymentMethod === "cash_on_pickup"
            ? "Payment is due directly to the seller at pickup."
            : "Payment has not been confirmed yet.",
        settlementStatus:
          paymentMethod === "cash_on_pickup" ? "cash_due" : "payment_pending",
        settlementSellerId: group.shop.ownerId,
        shopId: group.shop._id,
        status: "pending",
        subtotalAmount,
        totalAmount: subtotalAmount + deliveryFee,
        workflowDeadlineAt:
          paymentMethod === "cash_on_pickup" ? now : undefined,
      };
    });

    const orders = await Order.create(documents, { session });
    await OrderEvent.create(
      orders.map((order) => ({
        actorId: req.user.id,
        actorType: "buyer",
        eventKey: `checkout:${checkoutKey}:order:${order._id}:created`,
        eventType: "order_created",
        message: "Buyer placed the order and its inventory was reserved.",
        notificationRequired: order.paymentMethod === "cash_on_pickup",
        notificationType:
          order.paymentMethod === "cash_on_pickup" ? "order_created" : undefined,
        orderId: order._id,
        to: {
          fulfillmentStatus: order.fulfillmentStatus,
          settlementStatus: order.settlementStatus,
        },
      })),
      { session },
    );
    return orders;
  });

  await syncListings(listingIds, "checkout-reserved");
  await invalidate(
    "listings:featured",
    ...groups.map((group) => `shop:${group.shop._id}:listings`),
    ...listingIds.map((listingId) => `listing:${listingId}`),
  );

  if (paymentMethod === "cash_on_pickup") {
    for (const order of createdOrders) {
      await notifyLifecycleEvent(order, "order_created");
      const claimedOrder = await Order.findOneAndUpdate(
        { _id: order._id, recommendationAwardedAt: null },
        { $set: { recommendationAwardedAt: new Date() } },
        { new: true },
      ).lean();
      if (claimedOrder) await awardPurchaseForOrder(claimedOrder).catch(() => undefined);
    }
    const orders = await Order.find({ _id: { $in: createdOrders.map((order) => order._id) } })
      .populate(participantPopulate)
      .sort({ createdAt: -1 });
    return success(
      res,
      {
        checkoutIdempotencyKey: checkoutKey,
        order: presentOrder(orders[0], req.user.id),
        orders: presentOrders(orders, req.user.id),
        payment: { mode: "pickup", provider: "cash", status: "pending" },
      },
      "Pickup order placed",
      201,
    );
  }

  const { providerTransaction } = await initializeReservedOrders({
    buyer,
    callbackUrl: req.body.callbackUrl,
    checkoutKey,
    currency: [...currencies][0],
    orders: createdOrders,
  });
  const orders = await Order.find({
    _id: { $in: createdOrders.map((order) => order._id) },
  })
    .populate(participantPopulate)
    .sort({ createdAt: -1 });

  return success(
    res,
    {
      checkoutIdempotencyKey: checkoutKey,
      order: presentOrder(orders[0], req.user.id),
      orders: presentOrders(orders, req.user.id),
      payment: toInlinePayment(providerTransaction),
    },
    "Payment initialized. Open the secure Paystack payment window.",
    201,
  );
});

const actionClausesFor = ({ buyer, now }) =>
  buyer
    ? [
        {
          "delivery.method": "shop_pickup",
          fulfillmentStatus: "awaiting_seller",
          settlementStatus: "cash_due",
        },
        {
          fulfillmentStatus: "awaiting_seller",
          sellerActionDeadline: { $lte: now },
          settlementStatus: "held",
        },
        {
          "delivery.method": "shop_pickup",
          fulfillmentStatus: "ready_for_pickup",
          pickupExpiresAt: { $gt: now },
          settlementStatus: "held",
        },
        {
          "delivery.method": { $in: ["station_pickup", "airport_to_airport"] },
          deliveryReleaseAt: { $gt: now },
          fulfillmentStatus: "in_transit",
          settlementStatus: "held",
        },
      ]
    : [
        {
          "delivery.method": "shop_pickup",
          fulfillmentStatus: "awaiting_seller",
          settlementStatus: { $in: ["cash_due", "held"] },
        },
        {
          "delivery.method": { $in: ["station_pickup", "airport_to_airport"] },
          fulfillmentStatus: "awaiting_seller",
          settlementStatus: "held",
        },
        {
          "delivery.method": "shop_pickup",
          fulfillmentStatus: "ready_for_pickup",
          settlementStatus: "cash_due",
        },
      ];

const queryForBucket = (bucket, { buyer, now }) => {
  if (bucket === "under_review") {
    return {
      $or: [
        { activeReportId: { $ne: null } },
        { settlementStatus: { $in: ["refund_attention", "refund_failed"] } },
      ],
    };
  }
  if (bucket === "active") {
    return {
      $or: [
        {
          fulfillmentStatus: {
            $in: ["awaiting_seller", "ready_for_pickup", "in_transit"],
          },
        },
        { activeReportId: { $ne: null } },
        {
          settlementStatus: {
            $in: ["refund_pending", "refund_attention", "refund_failed"],
          },
        },
      ],
    };
  }
  if (bucket === "history") {
    return {
      fulfillmentStatus: { $in: ["completed", "cancelled"] },
      settlementStatus: {
        $nin: ["refund_pending", "refund_attention", "refund_failed"],
      },
    };
  }
  if (bucket === "needs_action") {
    return {
      activeReportId: null,
      $or: actionClausesFor({ buyer, now }),
    };
  }
  if (bucket === "in_progress") {
    return {
      $or: [
        { settlementStatus: "refund_pending" },
        {
          activeReportId: null,
          fulfillmentStatus: {
            $in: ["awaiting_seller", "ready_for_pickup", "in_transit"],
          },
          $nor: actionClausesFor({ buyer, now }),
        },
      ],
    };
  }
  return {};
};

const encodeUrgencyCursor = (order) =>
  Buffer.from(
    JSON.stringify({
      deadline: order.workflowDeadlineAt
        ? new Date(order.workflowDeadlineAt).toISOString()
        : null,
      id: String(order._id),
    }),
  ).toString("base64url");

const decodeUrgencyCursor = (cursor) => {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!/^[a-f0-9]{24}$/i.test(parsed.id)) return null;
    if (parsed.deadline !== null && Number.isNaN(new Date(parsed.deadline).getTime())) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const orderSearchClause = async ({ buyerId, search, shopId }) => {
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "i");
  const clauses = [
    { "items.title": regex },
    { paymentRef: regex },
    {
      $expr: {
        $regexMatch: {
          input: { $toString: "$_id" },
          options: "i",
          regex: escaped,
        },
      },
    },
  ];

  if (buyerId) {
    const shopIds = await DigiShop.find({
      $or: [{ shopName: regex }, { slug: regex }],
    }).distinct("_id");
    if (shopIds.length) clauses.push({ shopId: { $in: shopIds } });
  } else if (shopId) {
    const buyerIds = await User.find({
      $or: [{ name: regex }, { username: regex }],
    }).distinct("_id");
    if (buyerIds.length) clauses.push({ buyerId: { $in: buyerIds } });
  }

  return { $or: clauses };
};

const listOrders = async ({ buyerId, req, shopId }) => {
  const now = new Date();
  const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 50);
  const filter = {
    ...(buyerId ? { buyerId } : {}),
    ...(shopId ? { shopId, settlementStatus: { $ne: "payment_pending" } } : {}),
    ...(shopId ? { checkoutCancelledAt: null } : {}),
    ...queryForBucket(req.query.bucket, { buyer: Boolean(buyerId), now }),
  };
  if (buyerId) {
    filter.$and = [
      {
        $or: [
          { checkoutCancelledAt: null },
          {
            settlementStatus: {
              $in: [
                "refund_pending",
                "refund_attention",
                "refund_failed",
                "refunded",
              ],
            },
          },
        ],
      },
    ];
  }
  if (req.query.method) filter["delivery.method"] = req.query.method;
  if (req.query.cursor && req.query.sort === "urgency") {
    const cursor = decodeUrgencyCursor(req.query.cursor);
    if (!cursor) throw httpError(422, "Invalid order cursor");
    const cursorClause = cursor.deadline
      ? {
          $or: [
            { workflowDeadlineAt: { $gt: new Date(cursor.deadline) } },
            {
              workflowDeadlineAt: new Date(cursor.deadline),
              _id: { $gt: new mongoose.Types.ObjectId(cursor.id) },
            },
            { workflowDeadlineAt: null },
          ],
        }
      : {
          workflowDeadlineAt: null,
          _id: { $gt: new mongoose.Types.ObjectId(cursor.id) },
        };
    filter.$and = [...(filter.$and || []), cursorClause];
  } else if (req.query.cursor) {
    filter._id = { $lt: req.query.cursor };
  }
  const search = asTrimmed(req.query.search, 100);
  if (search) {
    filter.$and = [
      ...(filter.$and || []),
      await orderSearchClause({ buyerId, search, shopId }),
    ];
  }

  let orders;
  if (req.query.sort === "urgency") {
    const aggregateFilter = {
      ...filter,
      ...(buyerId && mongoose.isValidObjectId(buyerId)
        ? { buyerId: new mongoose.Types.ObjectId(buyerId) }
        : {}),
      ...(shopId && mongoose.isValidObjectId(shopId)
        ? { shopId: new mongoose.Types.ObjectId(shopId) }
        : {}),
    };
    const rankedIds = await Order.aggregate([
      { $match: aggregateFilter },
      {
        $addFields: {
          __deadlineMissing: {
            $cond: [
              { $eq: [{ $type: "$workflowDeadlineAt" }, "date"] },
              0,
              1,
            ],
          },
        },
      },
      { $sort: { __deadlineMissing: 1, workflowDeadlineAt: 1, _id: 1 } },
      { $limit: limit + 1 },
      { $project: { _id: 1 } },
    ]);
    const ids = rankedIds.map((row) => row._id);
    const found = await Order.find({ _id: { $in: ids } }).populate(
      participantPopulate,
    );
    const byId = new Map(found.map((order) => [String(order._id), order]));
    orders = ids.map((id) => byId.get(String(id))).filter(Boolean);
  } else {
    orders = await Order.find(filter)
      .populate(participantPopulate)
      .sort({ _id: -1 })
      .limit(limit + 1);
  }
  const hasMore = orders.length > limit;
  const page = hasMore ? orders.slice(0, limit) : orders;
  const serverNow = new Date();
  return {
    hasMore,
    nextCursor: hasMore
      ? req.query.sort === "urgency"
        ? encodeUrgencyCursor(page[page.length - 1])
        : String(page[page.length - 1]._id)
      : null,
    orders: presentOrders(page, req.user.id, serverNow),
    serverNow: serverNow.toISOString(),
  };
};

exports.getOrdersByIds = asyncHandler(async (req, res, next) => {
  if (!req.query.ids) return next();
  const ids = String(req.query.ids)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 100);
  const orders = await Order.find({ _id: { $in: ids }, buyerId: req.user.id })
    .populate(participantPopulate)
    .sort({ createdAt: -1 });
  return success(res, { orders: presentOrders(orders, req.user.id) }, "Orders loaded");
});

exports.getBuyingOrders = asyncHandler(async (req, res) => {
  const page = await listOrders({ buyerId: req.user.id, req });
  return success(res, page, "Buying orders loaded");
});

exports.getSellingOrders = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id }).select("_id");
  if (!shop) {
    return success(
      res,
      { hasMore: false, nextCursor: null, orders: [], serverNow: new Date().toISOString() },
      "Selling orders loaded",
    );
  }
  const page = await listOrders({ req, shopId: shop._id });
  return success(res, page, "Selling orders loaded");
});

exports.getSellingOrdersSummary = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id }).select("_id");
  const serverNow = new Date();
  if (!shop) {
    return success(
      res,
      {
        activeOrderCount: 0,
        releasedRevenue: 0,
        serverNow: serverNow.toISOString(),
      },
      "Selling order summary loaded",
    );
  }

  const [summary] = await Order.aggregate([
    {
      $match: {
        checkoutCancelledAt: null,
        settlementStatus: { $ne: "payment_pending" },
        shopId: shop._id,
      },
    },
    {
      $facet: {
        activeOrders: [
          {
            $match: queryForBucket("active", {
              buyer: false,
              now: serverNow,
            }),
          },
          { $count: "count" },
        ],
        releasedRevenue: [
          { $match: { settlementStatus: "released" } },
          {
            $group: {
              _id: null,
              amount: { $sum: "$totalAmount" },
            },
          },
        ],
      },
    },
  ]);

  return success(
    res,
    {
      activeOrderCount: summary?.activeOrders?.[0]?.count || 0,
      releasedRevenue: summary?.releasedRevenue?.[0]?.amount || 0,
      serverNow: serverNow.toISOString(),
    },
    "Selling order summary loaded",
  );
});

exports.getOrder = asyncHandler(async (req, res) => {
  const { order } = await loadParticipantOrder(req.params.id, req.user.id);
  const events = await OrderEvent.find({ orderId: order._id })
    .sort({ createdAt: 1, _id: 1 })
    .limit(250);
  return success(
    res,
    {
      events,
      order: presentOrder(order, req.user.id),
    },
    "Order loaded",
  );
});

exports.getOrderEvents = asyncHandler(async (req, res) => {
  const { order } = await loadParticipantOrder(req.params.id, req.user.id);
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 250);
  const filter = { orderId: order._id };
  if (req.query.cursor) {
    filter._id = { $gt: req.query.cursor };
  }
  const events = await OrderEvent.find(filter).sort({ _id: 1 }).limit(limit + 1);
  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  return success(
    res,
    {
      events: page,
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    },
    "Order events loaded",
  );
});

const sendActionResult = (message) =>
  asyncHandler(async (req, res) => {
    const order = await message.handler(req);
    return success(
      res,
      { order: presentOrder(order, req.user.id) },
      message.success,
    );
  });

exports.cancelCashPickup = sendActionResult({
  handler: (req) =>
    cancelCashPickup({
      idempotencyKey: idempotencyKeyFor(req),
      orderId: req.params.id,
      userId: req.user.id,
    }),
  success: "Cash pickup cancelled and inventory restored",
});

exports.markPickupReady = sendActionResult({
  handler: (req) =>
    markPickupReady({
      idempotencyKey: idempotencyKeyFor(req),
      note: req.body.note,
      orderId: req.params.id,
      userId: req.user.id,
    }),
  success: "Pickup marked ready",
});

exports.completeCashPickup = sendActionResult({
  handler: (req) =>
    completeCashPickup({
      idempotencyKey: idempotencyKeyFor(req),
      orderId: req.params.id,
      userId: req.user.id,
    }),
  success: "Pickup and cash receipt confirmed",
});

exports.releaseUnclaimedPickup = sendActionResult({
  handler: (req) =>
    releaseUnclaimedPickup({
      idempotencyKey: idempotencyKeyFor(req),
      orderId: req.params.id,
      userId: req.user.id,
    }),
  success: "Unclaimed pickup returned to inventory",
});

exports.confirmCollection = sendActionResult({
  handler: (req) =>
    confirmCollection({
      idempotencyKey: idempotencyKeyFor(req),
      orderId: req.params.id,
      userId: req.user.id,
    }),
  success: "Collection confirmed and funds released",
});

exports.dispatch = sendActionResult({
  handler: async (req) => {
    const billImage = req.privateUploadMap?.billImage?.[0];
    if (!billImage) throw httpError(422, "A waybill image is required");
    const cargoTrackingNumber = asTrimmed(req.body.cargoTrackingNumber, 120);
    const order = await dispatchOrder({
      billImage,
      cargoTrackingNumber,
      idempotencyKey: idempotencyKeyFor(req),
      orderId: req.params.id,
      userId: req.user.id,
    });
    req.committedPrivateKeys = [
      ...(req.committedPrivateKeys || []),
      billImage.key,
    ];
    return order;
  },
  success: "Order marked as sent",
});

exports.confirmReceipt = sendActionResult({
  handler: (req) =>
    confirmReceipt({
      idempotencyKey: idempotencyKeyFor(req),
      orderId: req.params.id,
      userId: req.user.id,
    }),
  success: "Receipt confirmed and funds released",
});

exports.closeNoAction = sendActionResult({
  handler: async (req) => {
    const result = await closeNoAction({
      idempotencyKey: idempotencyKeyFor(req),
      orderId: req.params.id,
      userId: req.user.id,
    });
    return result.order || result;
  },
  success: "Order closed and refund requested",
});

exports.createReport = asyncHandler(async (req, res) => {
  const category =
    req.body.category === "non_receipt" ? "not_received" : req.body.category;
  const requestedOutcome = req.body.requestedOutcome;
  if (!ORDER_REPORT_CATEGORIES.includes(category)) {
    throw httpError(422, "Choose a valid report category");
  }
  if (!ORDER_REPORT_OUTCOMES.includes(requestedOutcome)) {
    throw httpError(422, "Choose a valid requested outcome");
  }
  const detailedAccount = asTrimmed(
    req.body.detailedAccount || req.body.details,
    5000,
  );
  if (detailedAccount.length < 20) {
    throw httpError(422, "Please provide at least 20 characters describing the issue");
  }
  const declarationAccepted =
    req.body.declarationAccepted === true ||
    String(req.body.declarationAccepted).toLowerCase() === "true";
  if (!declarationAccepted) {
    throw httpError(422, "The truthful-information declaration must be accepted");
  }

  const affectedItemIds = parseAffectedItems(req.body.affectedItemIds);
  if (!affectedItemIds.length) {
    throw httpError(422, "Select at least one affected item");
  }
  if (affectedItemIds.some((id) => !/^[a-f0-9]{24}$/i.test(id))) {
    throw httpError(422, "Affected item ids must be valid order item ids");
  }
  const report = await submitReport({
    affectedItemIds,
    category,
    declarationAccepted,
    detailedAccount,
    evidence: req.privateUploads || [],
    idempotencyKey: idempotencyKeyFor(req),
    orderId: req.params.id,
    requestedOutcome,
    userId: req.user.id,
  });
  req.committedPrivateKeys = [
    ...(req.committedPrivateKeys || []),
    ...(req.privateUploads || []).map((file) => file.key),
  ];
  const order = await Order.findById(req.params.id).populate(participantPopulate);
  return success(
    res,
    {
      order: presentOrder(order, req.user.id),
      report,
    },
    "Report submitted and settlement frozen",
    201,
  );
});

exports.getPrivateAttachment = asyncHandler(async (req, res) => {
  let order;
  try {
    ({ order } = await loadParticipantOrder(req.params.id, req.user.id));
  } catch (error) {
    if (
      error.statusCode !== 403 ||
      !hasAnyRole(req.user?.roles, ROLE_GROUPS.DISPUTE_RESOLUTION)
    ) {
      throw error;
    }
    order = await Order.findById(req.params.id).populate(participantPopulate);
    if (!order) throw httpError(404, "Order not found");
  }
  let attachment;

  if (req.params.kind === "transit-bill") {
    const privateOrder = await Order.findById(order._id).select(
      "+delivery.transit.billImage.key",
    );
    attachment = privateOrder?.delivery?.transit?.billImage;
  } else if (req.params.kind === "report-evidence") {
    if (!order.activeReportId) throw httpError(404, "Order report not found");
    const report = await OrderReport.findById(
      order.activeReportId?._id || order.activeReportId,
    ).select("+evidence.key");
    const index = Number(req.params.index || 0);
    if (!Number.isInteger(index) || index < 0 || index >= (report?.evidence?.length || 0)) {
      throw httpError(404, "Report evidence not found");
    }
    attachment = report.evidence[index];
  } else {
    throw httpError(404, "Attachment not found");
  }

  if (!attachment) throw httpError(404, "Attachment not found");
  const url = attachment.key
    ? await createPrivateDownloadUrl(attachment.key, 300)
    : attachment.url;
  if (!url) throw httpError(503, "Private attachment storage is unavailable");
  return success(
    res,
    {
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      mimetype: attachment.mimetype,
      originalName: attachment.originalName,
      size: attachment.size,
      url,
    },
    "Private attachment link created",
  );
});

/* Strict one-release compatibility adapters. */
exports.processOrder = asyncHandler(async (_req, _res) => {
  throw httpError(410, "Seller acceptance was removed; use the ready or dispatch action");
});

exports.markShipped = exports.dispatch;
exports.confirmDelivery = asyncHandler(async (req, res, next) => {
  const { order } = await loadParticipantOrder(req.params.id, req.user.id);
  if (order.delivery?.method === "shop_pickup") {
    return exports.confirmCollection(req, res, next);
  }
  return exports.confirmReceipt(req, res, next);
});

exports.raiseDispute = asyncHandler(async (_req, _res) => {
  throw httpError(410, "Reason-only disputes were retired; use the guided order report");
});
