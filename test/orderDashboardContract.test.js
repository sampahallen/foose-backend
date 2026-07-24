const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const DigiShop = require("../src/models/DigiShop");
const Order = require("../src/models/Order");
const orderController = require("../src/controllers/orderController");
const orderRoutes = require("../src/routes/orderRoutes");

const invokeController = (controller, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ payload, statusCode: this.statusCode });
        return payload;
      },
    };
    controller(req, res, reject);
  });

const emptyOrderQuery = (capture) => (filter) => {
  capture.push(filter);
  return {
    populate() {
      return this;
    },
    sort() {
      return this;
    },
    async limit() {
      return [];
    },
    then(resolve, reject) {
      return Promise.resolve([]).then(resolve, reject);
    },
  };
};

const assertActivePredicate = (filter) => {
  assert.deepEqual(filter.$or, [
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
  ]);
};

test("the active bucket covers live fulfillment, reports, and unresolved refunds for both roles", async () => {
  const originalFind = Order.find;
  const originalFindOne = DigiShop.findOne;
  const captured = [];
  const shopId = new mongoose.Types.ObjectId();

  Order.find = emptyOrderQuery(captured);
  DigiShop.findOne = () => ({
    select: async () => ({ _id: shopId }),
  });

  try {
    await invokeController(orderController.getBuyingOrders, {
      query: { bucket: "active" },
      user: { id: new mongoose.Types.ObjectId().toString() },
    });
    await invokeController(orderController.getSellingOrders, {
      query: { bucket: "active" },
      user: { id: new mongoose.Types.ObjectId().toString() },
    });
  } finally {
    Order.find = originalFind;
    DigiShop.findOne = originalFindOne;
  }

  assert.equal(captured.length, 2);
  assertActivePredicate(captured[0]);
  assertActivePredicate(captured[1]);
  assert.deepEqual(captured[0].$and, [
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
  ]);
  assert.deepEqual(captured[1].settlementStatus, { $ne: "payment_pending" });
  assert.equal(captured[1].checkoutCancelledAt, null);
  assert.equal(captured[1].shopId, shopId);
});

test("seller summary counts the full active predicate and sums only released revenue", async () => {
  const originalAggregate = Order.aggregate;
  const originalFindOne = DigiShop.findOne;
  const shopId = new mongoose.Types.ObjectId();
  let pipeline;

  DigiShop.findOne = () => ({
    select: async () => ({ _id: shopId }),
  });
  Order.aggregate = async (value) => {
    pipeline = value;
    return [
      {
        activeOrders: [{ count: 73 }],
        releasedRevenue: [{ amount: 12540 }],
      },
    ];
  };

  let result;
  try {
    result = await invokeController(orderController.getSellingOrdersSummary, {
      query: {},
      user: { id: new mongoose.Types.ObjectId().toString() },
    });
  } finally {
    Order.aggregate = originalAggregate;
    DigiShop.findOne = originalFindOne;
  }

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.data.activeOrderCount, 73);
  assert.equal(result.payload.data.releasedRevenue, 12540);
  assert.match(result.payload.data.serverNow, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(pipeline[0].$match, {
    checkoutCancelledAt: null,
    settlementStatus: { $ne: "payment_pending" },
    shopId,
  });
  assertActivePredicate(pipeline[1].$facet.activeOrders[0].$match);
  assert.deepEqual(pipeline[1].$facet.releasedRevenue[0], {
    $match: { settlementStatus: "released" },
  });
  assert.deepEqual(pipeline[1].$facet.releasedRevenue[1], {
    $group: {
      _id: null,
      amount: { $sum: "$totalAmount" },
    },
  });
});

test("order confirmation lookup accepts every possible seller order from a 100-item checkout", async () => {
  const originalFind = Order.find;
  const captured = [];
  Order.find = emptyOrderQuery(captured);
  const ids = Array.from({ length: 101 }, (_, index) =>
    index.toString(16).padStart(24, "0"),
  );

  try {
    await invokeController(orderController.getOrdersByIds, {
      query: { ids: ids.join(",") },
      user: { id: new mongoose.Types.ObjectId().toString() },
    });
  } finally {
    Order.find = originalFind;
  }

  assert.equal(captured[0]._id.$in.length, 100);
  assert.equal(captured[0]._id.$in[99], ids[99]);
});

test("seller summary route is registered before the dynamic order detail route", () => {
  const summaryIndex = orderRoutes.stack.findIndex(
    (layer) =>
      layer.route?.path === "/me/selling/summary" &&
      layer.route.methods.get,
  );
  const detailIndex = orderRoutes.stack.findIndex(
    (layer) => layer.route?.path === "/:id" && layer.route.methods.get,
  );

  assert.ok(summaryIndex >= 0);
  assert.ok(detailIndex >= 0);
  assert.ok(summaryIndex < detailIndex);
});
