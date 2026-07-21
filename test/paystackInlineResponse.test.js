const test = require("node:test");
const assert = require("node:assert/strict");
const { toInlinePayment } = require("../src/services/paystackService");

test("Paystack initialization exposes only the inline session fields", () => {
  const payment = toInlinePayment({
    access_code: "access-code",
    authorization_url: "https://checkout.paystack.com/external",
    reference: "payment-reference",
  });

  assert.deepEqual(payment, {
    accessCode: "access-code",
    provider: "paystack",
    reference: "payment-reference",
    status: "pending",
  });
  assert.equal(Object.hasOwn(payment, "authorizationUrl"), false);
});
