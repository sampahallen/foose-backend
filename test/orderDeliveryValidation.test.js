const test = require("node:test");
const assert = require("node:assert/strict");
const Listing = require("../src/models/Listing");
const Order = require("../src/models/Order");
const orderController = require("../src/controllers/orderController");

const invokeForError = (controller, req) => new Promise((resolve, reject) => {
  controller(req, {}, (error) => {
    if (error) resolve(error);
    else reject(new Error("Controller continued without reporting a validation error"));
  });
});

test("station pickup rejects an order without a destination", async () => {
  const error = await invokeForError(orderController.placeOrder, {
    body: {
      deliveryByShop: {
        "shop-1": { address: { region: "Greater Accra" }, method: "station_pickup" },
      },
      items: [{ listingId: "listing-1", quantity: 1 }],
      paymentMethod: "paystack",
    },
    user: { id: "buyer-1" },
  });

  assert.equal(error.statusCode, 422);
  assert.equal(error.message, "Destination details are required for this delivery method");
});

test("a seller cannot create an order for their own listing", async () => {
  const originalFind = Listing.find;
  const originalOrderFind = Order.find;
  Listing.find = () => ({
    populate: async () => [{
      _id: { toString: () => "listing-1" },
      shopId: { _id: "shop-1", ownerId: "seller-1" },
      status: "active",
    }],
  });
  Order.find = () => ({
    populate: async () => [],
    select() {
      return this;
    },
  });

  try {
    const error = await invokeForError(orderController.placeOrder, {
      body: {
        deliveryByShop: { "shop-1": { method: "shop_pickup" } },
        items: [{ listingId: "listing-1", quantity: 1 }],
        paymentMethod: "cash_on_pickup",
      },
      headers: { "idempotency-key": "seller-own-listing-test" },
      user: { id: "seller-1" },
    });

    assert.equal(error.statusCode, 403);
    assert.equal(error.message, "You cannot purchase your own listing");
  } finally {
    Listing.find = originalFind;
    Order.find = originalOrderFind;
  }
});

test("checkout idempotency keys reject a different canonical request", async () => {
  const originalFind = Order.find;
  Order.find = () => ({
    populate: async () => [
      {
        _id: "existing-order",
        checkoutRequestHash: "a".repeat(64),
        delivery: { method: "shop_pickup" },
        items: [{ listingId: "listing-1", quantity: 1 }],
        paymentMethod: "cash_on_pickup",
        shopId: "shop-1",
      },
    ],
    select() {
      return this;
    },
  });

  try {
    const error = await invokeForError(orderController.placeOrder, {
      body: {
        deliveryByShop: { "shop-1": { method: "shop_pickup" } },
        items: [{ listingId: "listing-2", quantity: 1 }],
        paymentMethod: "cash_on_pickup",
      },
      headers: { "idempotency-key": "same-key" },
      user: { id: "buyer-1" },
    });

    assert.equal(error.statusCode, 409);
    assert.match(error.message, /different checkout request/);
  } finally {
    Order.find = originalFind;
  }
});
