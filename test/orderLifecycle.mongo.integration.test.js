const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const mongoTestUri = String(process.env.MONGODB_TEST_URI || "").trim();

if (!mongoTestUri) {
  test(
    "Mongo-backed order lifecycle integration tests",
    {
      skip: "Set MONGODB_TEST_URI to a transaction-capable MongoDB test deployment",
    },
    () => {},
  );
} else {
  const mongoose = require("mongoose");
  const DigiShop = require("../src/models/DigiShop");
  const Notification = require("../src/models/Notification");
  const Order = require("../src/models/Order");
  const OrderEvent = require("../src/models/OrderEvent");
  const OrderReport = require("../src/models/OrderReport");
  const Settlement = require("../src/models/Settlement");
  const User = require("../src/models/User");
  const WalletLedgerEntry = require("../src/models/WalletLedgerEntry");
  const {
    confirmCollection,
    releaseExpiredDelivery,
    resolveOrderReport,
    submitReport,
  } = require("../src/services/orderLifecycleService");

  const databaseNameFromUri = () => {
    let base = "foose";
    try {
      const parsed = new URL(mongoTestUri);
      base = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")) || base;
    } catch {
      // Mongoose will provide the actionable URI error. The fallback still
      // guarantees that this suite never selects an application database.
    }
    const safeBase = base.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 18) || "foose";
    const suffix = `${process.pid}_${Date.now().toString(36)}_${crypto
      .randomBytes(3)
      .toString("hex")}`;
    return `${safeBase}_order_it_${suffix}`.slice(0, 63);
  };

  const testDatabaseName = databaseNameFromUri();
  const createdDatabaseName = { value: "" };

  const createUser = (tag, wallet = {}) => {
    const usernameBase =
      tag.replace(/[^a-z0-9_.]/gi, "_").toLowerCase().slice(0, 10) || "user";
    const usernameHash = crypto
      .createHash("sha256")
      .update(tag)
      .digest("hex")
      .slice(0, 8);
    return User.create({
      email: `${tag}@integration.foose.test`,
      isEmailVerified: true,
      name: `Lifecycle ${tag}`,
      passwordHash: "not-used-by-integration-tests",
      username: `${usernameBase}_${usernameHash}`,
      wallet: {
        balance: Number(wallet.balance || 0),
        escrow: Number(wallet.escrow || 0),
      },
    });
  };

  const createParticipants = async (tag, amount, { replacementOwner = false } = {}) => {
    const buyer = await createUser(`${tag}_buyer`);
    const pinnedSeller = await createUser(`${tag}_seller`, {
      balance: 25,
      escrow: amount,
    });
    const shop = await DigiShop.create({
      ownerId: pinnedSeller._id,
      shopName: `${tag} shop`,
      slug: `${tag}-shop`,
    });
    let currentOwner = pinnedSeller;

    if (replacementOwner) {
      currentOwner = await createUser(`${tag}_new_owner`, {
        balance: 7,
        escrow: 0,
      });
      await DigiShop.updateOne(
        { _id: shop._id },
        { $set: { ownerId: currentOwner._id } },
      );
    }

    return { buyer, currentOwner, pinnedSeller, shop };
  };

  const createHeldOrder = ({
    amount,
    buyerId,
    delivery,
    fulfillmentStatus,
    settlementSellerId,
    shopId,
    timestamps = {},
  }) =>
    Order.create({
      buyerId,
      currency: "GHS",
      delivery,
      deliveryFee: 0,
      escrowStatus: "held",
      fulfillmentStatus,
      items: [
        {
          price: amount,
          quantity: 1,
          title: "Mongo lifecycle integration item",
        },
      ],
      paymentMethod: "paystack",
      paymentRef: `test_charge_${crypto.randomUUID()}`,
      paymentStatus: "paid",
      sellerAction:
        fulfillmentStatus === "ready_for_pickup" ? "pickup_ready" : "shipped",
      settlementExplanation: "Funds are protected for the integration test.",
      settlementSellerId,
      settlementStatus: "held",
      shopId,
      status: fulfillmentStatus === "in_transit" ? "shipped" : "processing",
      subtotalAmount: amount,
      totalAmount: amount,
      ...timestamps,
    });

  test.before(async () => {
    await mongoose.connect(mongoTestUri, {
      dbName: testDatabaseName,
      serverSelectionTimeoutMS: 10_000,
    });
    createdDatabaseName.value = mongoose.connection.name;
    assert.equal(
      createdDatabaseName.value,
      testDatabaseName,
      "integration suite must connect to its generated dedicated database",
    );

    await Promise.all([
      DigiShop.init(),
      Notification.init(),
      Order.init(),
      OrderEvent.init(),
      OrderReport.init(),
      Settlement.init(),
      User.init(),
      WalletLedgerEntry.init(),
    ]);
  });

  test.after(async () => {
    try {
      if (
        mongoose.connection.readyState === 1 &&
        createdDatabaseName.value === testDatabaseName &&
        mongoose.connection.name === testDatabaseName
      ) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      await mongoose.disconnect();
    }
  });

  test(
    "concurrent online-pickup confirmations release exactly once to the pinned seller",
    { timeout: 30_000 },
    async () => {
      const amount = 180;
      const { buyer, currentOwner, pinnedSeller, shop } =
        await createParticipants("pickup_race", amount, {
          replacementOwner: true,
        });
      const now = new Date();
      const order = await createHeldOrder({
        amount,
        buyerId: buyer._id,
        delivery: { fee: 0, method: "shop_pickup" },
        fulfillmentStatus: "ready_for_pickup",
        settlementSellerId: pinnedSeller._id,
        shopId: shop._id,
        timestamps: {
          pickupExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          readyAt: new Date(now.getTime() - 1000),
          workflowDeadlineAt: new Date(now.getTime() + 60 * 60 * 1000),
        },
      });

      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          confirmCollection({
            idempotencyKey: "same-browser-retry",
            now,
            orderId: order._id,
            userId: buyer._id,
          }),
        ),
      );

      assert.equal(
        attempts.filter(({ status }) => status === "rejected").length,
        0,
        attempts
          .filter(({ status }) => status === "rejected")
          .map(({ reason }) => reason?.stack || reason)
          .join("\n"),
      );

      const [storedOrder, pinnedAfter, currentOwnerAfter, settlements, ledger] =
        await Promise.all([
          Order.findById(order._id).lean(),
          User.findById(pinnedSeller._id).lean(),
          User.findById(currentOwner._id).lean(),
          Settlement.find({ orderId: order._id }).lean(),
          WalletLedgerEntry.find({ orderId: order._id }).lean(),
        ]);

      assert.equal(storedOrder.fulfillmentStatus, "completed");
      assert.equal(storedOrder.settlementStatus, "released");
      assert.equal(String(storedOrder.settlementSellerId), String(pinnedSeller._id));
      assert.equal(pinnedAfter.wallet.balance, 25 + amount);
      assert.equal(pinnedAfter.wallet.escrow, 0);
      assert.equal(currentOwnerAfter.wallet.balance, 7);
      assert.equal(currentOwnerAfter.wallet.escrow, 0);

      assert.equal(settlements.length, 1);
      assert.equal(settlements[0].type, "release");
      assert.equal(settlements[0].status, "processed");
      assert.equal(settlements[0].destination, "seller_wallet");
      assert.equal(settlements[0].amount, amount);

      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].entryType, "escrow_release");
      assert.equal(String(ledger[0].userId), String(pinnedSeller._id));
      assert.equal(ledger[0].balanceDelta, amount);
      assert.equal(ledger[0].escrowDelta, -amount);
      assert.equal(
        await OrderEvent.countDocuments({
          eventType: "funds_released",
          orderId: order._id,
        }),
        1,
      );
    },
  );

  test(
    "buyer report and delivery-expiry release are first-action-wins without mixed settlement",
    { timeout: 30_000 },
    async () => {
      const amount = 240;
      const { buyer, pinnedSeller, shop } = await createParticipants(
        "report_release_race",
        amount,
      );
      const boundary = new Date(Date.now() + 500);
      const order = await createHeldOrder({
        amount,
        buyerId: buyer._id,
        delivery: {
          company: "Intercity STC",
          fee: 0,
          method: "station_pickup",
          transit: {
            cargoTrackingNumber: "",
          },
        },
        fulfillmentStatus: "in_transit",
        settlementSellerId: pinnedSeller._id,
        shopId: shop._id,
        timestamps: {
          deliveryReleaseAt: boundary,
          sentAt: new Date(boundary.getTime() - 36 * 60 * 60 * 1000),
          workflowDeadlineAt: boundary,
        },
      });

      const reportAttempt = submitReport({
        affectedItemIds: [order.items[0]._id],
        category: "not_received",
        declarationAccepted: true,
        detailedAccount:
          "The parcel has not arrived, so settlement must remain protected during review.",
        idempotencyKey: "boundary-report",
        now: new Date(boundary.getTime() - 1),
        orderId: order._id,
        requestedOutcome: "refund",
        userId: buyer._id,
      });
      const releaseAttempt = releaseExpiredDelivery({
        now: boundary,
        orderId: order._id,
      });

      await Promise.allSettled([reportAttempt, releaseAttempt]);

      const [storedOrder, sellerAfter, reportCount, settlementCount, events] =
        await Promise.all([
          Order.findById(order._id).lean(),
          User.findById(pinnedSeller._id).lean(),
          OrderReport.countDocuments({ orderId: order._id, isActive: true }),
          Settlement.countDocuments({ orderId: order._id, type: "release" }),
          OrderEvent.find({
            eventType: { $in: ["order_reported", "funds_released"] },
            orderId: order._id,
          })
            .select("eventType")
            .lean(),
        ]);

      assert.equal(
        reportCount + settlementCount,
        1,
        "exactly one competing financial transition must commit",
      );
      assert.equal(events.length, 1);

      if (reportCount === 1) {
        assert.ok(storedOrder.activeReportId);
        assert.equal(storedOrder.fulfillmentStatus, "in_transit");
        assert.equal(storedOrder.settlementStatus, "held");
        assert.equal(sellerAfter.wallet.balance, 25);
        assert.equal(sellerAfter.wallet.escrow, amount);
        assert.equal(events[0].eventType, "order_reported");
      } else {
        assert.equal(storedOrder.activeReportId, undefined);
        assert.equal(storedOrder.fulfillmentStatus, "completed");
        assert.equal(storedOrder.settlementStatus, "released");
        assert.equal(sellerAfter.wallet.balance, 25 + amount);
        assert.equal(sellerAfter.wallet.escrow, 0);
        assert.equal(events[0].eventType, "funds_released");
      }
    },
  );

  test(
    "admin seller resolution closes the report and releases escrow exactly once",
    { timeout: 30_000 },
    async () => {
      const amount = 320;
      const { buyer, pinnedSeller, shop } = await createParticipants(
        "admin_seller_resolution",
        amount,
      );
      const resolver = await createUser("admin_dispute_resolver");
      const now = new Date();
      const order = await createHeldOrder({
        amount,
        buyerId: buyer._id,
        delivery: { fee: 0, method: "shop_pickup" },
        fulfillmentStatus: "ready_for_pickup",
        settlementSellerId: pinnedSeller._id,
        shopId: shop._id,
        timestamps: {
          pickupExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          readyAt: new Date(now.getTime() - 1000),
          workflowDeadlineAt: new Date(now.getTime() + 60 * 60 * 1000),
        },
      });
      const report = await submitReport({
        affectedItemIds: [order.items[0]._id],
        category: "damaged_or_not_as_described",
        declarationAccepted: true,
        detailedAccount:
          "The buyer reported damage, but the reviewed evidence supports releasing the protected payment.",
        idempotencyKey: "admin-seller-report",
        now,
        orderId: order._id,
        requestedOutcome: "refund",
        userId: buyer._id,
      });

      const attempts = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          resolveOrderReport({
            awardedTo: "seller",
            note: "Evidence reviewed; the delivered item matches the listing and the seller fulfilled the order.",
            now: new Date(now.getTime() + 1000),
            orderId: order._id,
            resolverId: resolver._id,
          }),
        ),
      );
      assert.equal(
        attempts.filter(({ status }) => status === "rejected").length,
        0,
        attempts
          .filter(({ status }) => status === "rejected")
          .map(({ reason }) => reason?.stack || reason)
          .join("\n"),
      );

      const [storedOrder, storedReport, sellerAfter, settlements, ledger] =
        await Promise.all([
          Order.findById(order._id).lean(),
          OrderReport.findById(report._id).lean(),
          User.findById(pinnedSeller._id).lean(),
          Settlement.find({ orderId: order._id }).lean(),
          WalletLedgerEntry.find({ orderId: order._id }).lean(),
        ]);

      assert.equal(storedOrder.activeReportId, undefined);
      assert.equal(storedOrder.fulfillmentStatus, "completed");
      assert.equal(storedOrder.settlementStatus, "released");
      assert.equal(storedOrder.reportResolution.awardedTo, "seller");
      assert.equal(storedReport.isActive, false);
      assert.equal(storedReport.status, "resolved");
      assert.equal(storedReport.resolution.awardedTo, "seller");
      assert.equal(String(storedReport.resolution.resolverId), String(resolver._id));
      assert.match(storedReport.resolution.note, /evidence reviewed/i);
      assert.equal(sellerAfter.wallet.balance, 25 + amount);
      assert.equal(sellerAfter.wallet.escrow, 0);
      assert.equal(settlements.length, 1);
      assert.equal(settlements[0].type, "release");
      assert.equal(settlements[0].trigger, "report_resolution");
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].entryType, "escrow_release");
      assert.equal(
        await OrderEvent.countDocuments({
          eventType: "funds_released",
          orderId: order._id,
        }),
        1,
      );
    },
  );
}
