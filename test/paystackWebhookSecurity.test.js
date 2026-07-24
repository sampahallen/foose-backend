const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { verifyWebhookSignature } = require("../src/services/paystackService");

test("Paystack webhook verification fails closed without a configured secret", () => {
  const previous = process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYSTACK_SECRET_KEY;
  try {
    assert.equal(verifyWebhookSignature("{}", "anything"), false);
  } finally {
    if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previous;
  }
});

test("Paystack webhook verification accepts only the matching HMAC", () => {
  const previous = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "test-secret";
  const body = JSON.stringify({ event: "charge.success", data: { reference: "ref" } });
  const signature = crypto
    .createHmac("sha512", "test-secret")
    .update(body)
    .digest("hex");
  try {
    assert.equal(verifyWebhookSignature(body, signature), true);
    assert.equal(verifyWebhookSignature(`${body} `, signature), false);
  } finally {
    if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previous;
  }
});
