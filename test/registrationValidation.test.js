const test = require("node:test");
const assert = require("node:assert/strict");
const authRoutes = require("../src/routes/authRoutes");
const { GHANA_REGIONS } = require("../src/constants/ghanaRegions");

const validRegistration = {
  email: "buyer@example.com",
  location: { city: "Accra", region: "Greater Accra" },
  name: "Foose Buyer",
  password: "Strong1!",
  username: "foose.buyer",
};

test("registration requires a complete Ghana location", () => {
  const schema = authRoutes.registerBodySchema;
  assert.equal(schema.safeParse({ ...validRegistration, location: undefined }).success, false);
  assert.equal(schema.safeParse({ ...validRegistration, location: { region: "Greater Accra" } }).success, false);
  assert.equal(schema.safeParse({ ...validRegistration, location: { city: "Accra" } }).success, false);
});

test("registration rejects unknown regions and short cities", () => {
  const schema = authRoutes.registerBodySchema;
  assert.equal(schema.safeParse({ ...validRegistration, location: { city: "Accra", region: "Unknown" } }).success, false);
  assert.equal(schema.safeParse({ ...validRegistration, location: { city: " A ", region: "Greater Accra" } }).success, false);
});

test("registration accepts every current Ghana region with a valid city", () => {
  const schema = authRoutes.registerBodySchema;
  assert.equal(GHANA_REGIONS.length, 16);
  GHANA_REGIONS.forEach((region) => {
    const parsed = schema.safeParse({ ...validRegistration, location: { city: "Accra", region } });
    assert.equal(parsed.success, true, region);
  });
});
