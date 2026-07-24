const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isOrderLifecycleWorkerEnabled,
} = require("../src/services/orderLifecycleWorker");

test("order lifecycle worker is opt-in when the flag is omitted", () => {
  assert.equal(isOrderLifecycleWorkerEnabled({ NODE_ENV: "production" }), false);
  assert.equal(
    isOrderLifecycleWorkerEnabled({
      NODE_ENV: "production",
      ORDER_LIFECYCLE_WORKER_ENABLED: "false",
    }),
    false,
  );
});

test("order lifecycle worker starts only with an explicit true outside tests", () => {
  assert.equal(
    isOrderLifecycleWorkerEnabled({
      NODE_ENV: "production",
      ORDER_LIFECYCLE_WORKER_ENABLED: "true",
    }),
    true,
  );
  assert.equal(
    isOrderLifecycleWorkerEnabled({
      NODE_ENV: "test",
      ORDER_LIFECYCLE_WORKER_ENABLED: "true",
    }),
    false,
  );
});
