const test = require("node:test");
const assert = require("node:assert/strict");
const authRoutes = require("../src/routes/authRoutes");
const User = require("../src/models/User");
const { DISPOSABLE_EMAIL_DOMAINS } = require("../src/constants/disposableEmailDomains");
const { findOrCreateOAuthUser } = require("../src/services/oauthService");
const { isDisposableEmail, normalizeEmailDomain } = require("../src/utils/email");

const validRegistration = {
  email: "buyer@example.com",
  location: { city: "Accra", region: "Greater Accra" },
  name: "Foose Buyer",
  password: "Strong1!",
  username: "foose.buyer",
};

test("registration rejects common disposable email providers", () => {
  [
    "person@mailinator.com",
    "person@10minutemail.com",
    "person@guerrillamail.com",
    "person@temp-mail.org",
    "person@yopmail.com",
    "person@1secmail.com",
    "person@mail.tm",
    "person@tempmailo.com",
    "person@dropmail.me",
    "person@emailnator.com",
    " PERSON@SUBDOMAIN.MAILINATOR.COM ",
  ].forEach((email) => {
    const result = authRoutes.registerBodySchema.safeParse({ ...validRegistration, email });
    assert.equal(result.success, false, email);
    assert.equal(
      result.error.issues.some((issue) => issue.message.includes("Disposable or temporary")),
      true,
      email,
    );
  });
});

test("the offline disposable-domain dataset provides broad known coverage", () => {
  assert.ok(DISPOSABLE_EMAIL_DOMAINS.length > 100_000);
});

test("domain matching does not reject domains that merely contain a blocked name", () => {
  [
    "buyer@example.com",
    "buyer@gmail.com",
    "buyer@mailinator-example.com",
    "buyer@yopmail.com.example",
    "buyer@proton.me",
  ].forEach((email) => {
    assert.equal(isDisposableEmail(email), false, email);
    assert.equal(
      authRoutes.registerBodySchema.safeParse({ ...validRegistration, email }).success,
      true,
      email,
    );
  });
});

test("email domain normalization is case-insensitive and handles Unicode domain forms", () => {
  assert.equal(normalizeEmailDomain(" Person@ＭＡＩＬＩＮＡＴＯＲ．ＣＯＭ "), "mailinator.com");
  assert.equal(isDisposableEmail(" Person@ＭＡＩＬＩＮＡＴＯＲ．ＣＯＭ "), true);
});

test("new OAuth accounts cannot bypass the disposable-domain restriction", async () => {
  const originalFindOne = User.findOne;
  User.findOne = () => ({ select: async () => null });

  try {
    await assert.rejects(
      findOrCreateOAuthUser({
        email: "oauth@mailinator.com",
        emailVerified: true,
        name: "OAuth User",
        provider: "google",
        providerId: "provider-user",
      }),
      (error) => error.statusCode === 400 && error.message.includes("Disposable or temporary"),
    );
  } finally {
    User.findOne = originalFindOne;
  }
});

test("provider-ID linked legacy OAuth accounts remain usable without trusting an unconfirmed email", async () => {
  const originalFindOne = User.findOne;
  const existing = {
    authProviders: [{
      email: "legacy@mailinator.com",
      provider: "google",
      providerId: "legacy-provider-user",
    }],
    isEmailVerified: false,
    profilePhoto: "",
    save: async () => undefined,
  };
  User.findOne = () => ({ select: async () => existing });

  try {
    const result = await findOrCreateOAuthUser({
      email: "legacy@mailinator.com",
      emailVerified: false,
      name: "Legacy User",
      provider: "google",
      providerId: "legacy-provider-user",
    });
    assert.equal(result, existing);
    assert.equal(existing.isEmailVerified, false);
    assert.equal(existing.authProviders.length, 1);
  } finally {
    User.findOne = originalFindOne;
  }
});

test("an unconfirmed OAuth claim cannot link itself to an account by matching email", async () => {
  const originalFindOne = User.findOne;
  let findCalls = 0;
  let saved = false;
  const existing = {
    authProviders: [],
    isEmailVerified: false,
    save: async () => { saved = true; },
  };
  User.findOne = () => ({
    select: async () => {
      findCalls += 1;
      return findCalls === 1 ? null : existing;
    },
  });

  try {
    await assert.rejects(
      findOrCreateOAuthUser({
        email: "buyer@example.com",
        emailVerified: false,
        provider: "google",
        providerId: "unconfirmed-provider",
      }),
      (error) => error.statusCode === 400 && error.message.includes("did not confirm"),
    );
    assert.equal(findCalls, 1, "email fallback lookup does not run for an unconfirmed claim");
    assert.equal(saved, false);
    assert.deepEqual(existing.authProviders, []);
    assert.equal(existing.isEmailVerified, false);
  } finally {
    User.findOne = originalFindOne;
  }
});

test("a provider-confirmed email may link and verify its matching existing account", async () => {
  const originalFindOne = User.findOne;
  let findCalls = 0;
  const existing = {
    authProviders: [],
    isEmailVerified: false,
    profilePhoto: "",
    save: async () => undefined,
  };
  User.findOne = () => ({
    select: async () => {
      findCalls += 1;
      return findCalls === 1 ? null : existing;
    },
  });

  try {
    const result = await findOrCreateOAuthUser({
      email: "buyer@example.com",
      emailVerified: true,
      provider: "google",
      providerId: "confirmed-provider",
    });
    assert.equal(result, existing);
    assert.equal(existing.isEmailVerified, true);
    assert.deepEqual(existing.authProviders, [{
      email: "buyer@example.com",
      provider: "google",
      providerId: "confirmed-provider",
    }]);
  } finally {
    User.findOne = originalFindOne;
  }
});
