const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

test("refund webhook correlates an unambiguous pending refund without merchant notes", async (t) => {
  const PaymentTransaction = require("../src/models/PaymentTransaction");
  const Settlement = require("../src/models/Settlement");
  const lifecycle = require("../src/services/orderLifecycleService");
  const controllerPath = require.resolve("../src/controllers/paymentController");
  const originals = {
    applyRefundProviderUpdate: lifecycle.applyRefundProviderUpdate,
    paymentFindOne: PaymentTransaction.findOne,
    settlementFind: Settlement.find,
    settlementFindOne: Settlement.findOne,
  };
  const previousSecret = process.env.PAYSTACK_SECRET_KEY;

  t.after(() => {
    lifecycle.applyRefundProviderUpdate = originals.applyRefundProviderUpdate;
    PaymentTransaction.findOne = originals.paymentFindOne;
    Settlement.find = originals.settlementFind;
    Settlement.findOne = originals.settlementFindOne;
    if (previousSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previousSecret;
    delete require.cache[controllerPath];
  });

  process.env.PAYSTACK_SECRET_KEY = "refund-webhook-secret";
  PaymentTransaction.findOne = () => ({
    select: async () => ({ _id: "payment-1" }),
  });
  Settlement.findOne = async () => null;

  let candidates = [{ _id: "settlement-1" }];
  let settlementFilter;
  Settlement.find = (filter) => {
    settlementFilter = filter;
    return {
      sort() {
        return this;
      },
      async limit() {
        return candidates;
      },
    };
  };

  const applied = [];
  lifecycle.applyRefundProviderUpdate = async (input) => {
    applied.push(input);
  };

  delete require.cache[controllerPath];
  const { webhook } = require(controllerPath);

  const invoke = (suffix) => {
    const body = {
      event: "refund.pending",
      data: {
        amount: "18500",
        currency: "GHS",
        refund_reference: null,
        status: "pending",
        transaction_reference: `checkout-${suffix}`,
      },
    };
    const rawBody = JSON.stringify(body);
    const signature = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest("hex");

    return new Promise((resolve, reject) => {
      webhook(
        {
          body,
          headers: { "x-paystack-signature": signature },
          rawBody,
        },
        {
          json(payload) {
            resolve(payload);
          },
          status() {
            return this;
          },
        },
        reject,
      );
    });
  };

  await invoke("one");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(settlementFilter, {
    amount: 18500,
    currency: "GHS",
    paymentTransactionId: "payment-1",
    type: "refund",
  });
  assert.deepEqual(applied, [
    {
      providerReference: "",
      providerStatus: "pending",
      settlementId: "settlement-1",
    },
  ]);

  candidates = [{ _id: "settlement-1" }, { _id: "settlement-2" }];
  await invoke("ambiguous");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied.length, 1);
});
