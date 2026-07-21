const test = require("node:test");
const assert = require("node:assert/strict");

test("payment cancellation releases reserved inventory exactly once", async (t) => {
  const Order = require("../src/models/Order");
  const Listing = require("../src/models/Listing");
  const paystackService = require("../src/services/paystackService");
  const searchService = require("../src/services/searchIndexService");
  const cache = require("../src/utils/cache");
  const controllerPath = require.resolve("../src/controllers/paymentController");
  const originals = {
    invalidate: cache.invalidate,
    listingUpdateOne: Listing.updateOne,
    orderFind: Order.find,
    orderFindOneAndUpdate: Order.findOneAndUpdate,
    runSearchSync: searchService.runSearchSync,
    syncListingSearchDocument: searchService.syncListingSearchDocument,
    verifyTransaction: paystackService.verifyTransaction,
  };

  t.after(() => {
    cache.invalidate = originals.invalidate;
    Listing.updateOne = originals.listingUpdateOne;
    Order.find = originals.orderFind;
    Order.findOneAndUpdate = originals.orderFindOneAndUpdate;
    searchService.runSearchSync = originals.runSearchSync;
    searchService.syncListingSearchDocument = originals.syncListingSearchDocument;
    paystackService.verifyTransaction = originals.verifyTransaction;
    delete require.cache[controllerPath];
  });

  let status = "pending";
  const listingUpdates = [];
  const orderRecord = () => ({
    _id: "order-1",
    buyerId: "buyer-1",
    escrowStatus: "not_held",
    items: [{ listingId: "listing-1", quantity: 2 }],
    paymentRef: "payment-reference",
    paymentStatus: "unpaid",
    shopId: "shop-1",
    status,
  });

  paystackService.verifyTransaction = async () => ({ status: "abandoned" });
  Order.find = async () => [orderRecord()];
  Order.findOneAndUpdate = async () => {
    if (status !== "pending") return null;
    status = "cancelled";
    return orderRecord();
  };
  Listing.updateOne = async (filter, update) => {
    listingUpdates.push({ filter, update });
    return { modifiedCount: 1 };
  };
  cache.invalidate = async () => undefined;
  searchService.runSearchSync = async (_key, operation) => operation();
  searchService.syncListingSearchDocument = async () => undefined;

  delete require.cache[controllerPath];
  const { cancelPayment } = require(controllerPath);
  const invoke = () => new Promise((resolve, reject) => {
    const res = {
      json(payload) {
        resolve(payload);
      },
      status() {
        return this;
      },
    };
    cancelPayment(
      { params: { reference: "payment-reference" }, user: { id: "buyer-1" } },
      res,
      reject,
    );
  });

  const first = await invoke();
  const second = await invoke();

  assert.equal(first.data.cancelled, true);
  assert.equal(first.data.releasedItemCount, 2);
  assert.equal(second.data.cancelled, true);
  assert.equal(second.data.releasedItemCount, 0);
  assert.equal(listingUpdates.length, 1);
  assert.deepEqual(listingUpdates[0].update, {
    $inc: { quantity: 2 },
    $set: { status: "active" },
  });
});
