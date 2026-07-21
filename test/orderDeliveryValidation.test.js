const test = require("node:test");
const assert = require("node:assert/strict");
const Listing = require("../src/models/Listing");
const orderController = require("../src/controllers/orderController");

const invokeForError = (controller, req) => new Promise((resolve, reject) => {
  controller(req, {}, (error) => {
    if (error) resolve(error);
    else reject(new Error("Controller continued without reporting a validation error"));
  });
});

test("standard delivery rejects an order without a street address", async () => {
  const error = await invokeForError(orderController.placeOrder, {
    body: {
      delivery: { address: { region: "Greater Accra" }, method: "delivery" },
      items: [{ listingId: "listing-1", quantity: 1 }],
      paymentMethod: "paystack",
    },
    user: { id: "buyer-1" },
  });

  assert.equal(error.statusCode, 422);
  assert.equal(error.message, "Street address is required for standard delivery");
});

test("a seller cannot create an order for their own listing", async () => {
  const originalFind = Listing.find;
  Listing.find = () => ({
    populate: async () => [{
      _id: { toString: () => "listing-1" },
      shopId: { _id: "shop-1", ownerId: "seller-1" },
      status: "active",
    }],
  });

  try {
    const error = await invokeForError(orderController.placeOrder, {
      body: {
        delivery: { method: "pickup" },
        items: [{ listingId: "listing-1", quantity: 1 }],
        paymentMethod: "cash_on_pickup",
      },
      user: { id: "seller-1" },
    });

    assert.equal(error.statusCode, 403);
    assert.equal(error.message, "You cannot purchase your own listing");
  } finally {
    Listing.find = originalFind;
  }
});
