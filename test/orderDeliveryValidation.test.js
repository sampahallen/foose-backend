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

test("intra-city courier rejects an order without a delivery address", async () => {
  const error = await invokeForError(orderController.placeOrder, {
    body: {
      deliveryByShop: {
        "shop-1": {
          destination: {
            recipientName: "Ama",
            recipientPhone: "0240000000",
            region: "Greater Accra",
            town: "Accra",
          },
          method: "intra_city_courier",
          provider: "bolt_send",
        },
      },
      items: [{ listingId: "listing-1", quantity: 1 }],
      paymentMethod: "paystack",
    },
    user: { id: "buyer-1" },
  });

  assert.equal(error.statusCode, 422);
  assert.equal(error.message, "Delivery address is required for door-to-door courier");
});

test("inter-city courier rejects an order without a chosen provider", async () => {
  const error = await invokeForError(orderController.placeOrder, {
    body: {
      deliveryByShop: {
        "shop-1": {
          destination: {
            deliveryAddress: "12 Ring Road",
            recipientName: "Ama",
            recipientPhone: "0240000000",
            region: "Ashanti",
            town: "Kumasi",
          },
          method: "inter_city_courier",
        },
      },
      items: [{ listingId: "listing-1", quantity: 1 }],
      paymentMethod: "paystack",
    },
    user: { id: "buyer-1" },
  });

  assert.equal(error.statusCode, 422);
  assert.equal(error.message, "Choose a delivery provider");
});

test("checkoutRequestHashFor changes when the chosen courier provider changes", () => {
  const base = {
    deliveryByShop: {
      "shop-1": {
        destination: { region: "Greater Accra", town: "Accra" },
        method: "intra_city_courier",
        provider: "bolt_send",
      },
    },
    items: [{ listingId: "listing-1", quantity: 1 }],
    paymentMethod: "paystack",
  };
  const withYango = {
    ...base,
    deliveryByShop: {
      "shop-1": { ...base.deliveryByShop["shop-1"], provider: "yango_delivery" },
    },
  };

  assert.notEqual(
    orderController.checkoutRequestHashFor(base),
    orderController.checkoutRequestHashFor(withYango),
  );
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
