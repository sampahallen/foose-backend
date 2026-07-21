const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const User = require("../src/models/User");
const ShadowProfile = require("../src/models/ShadowProfile");
const Notification = require("../src/models/Notification");
const authController = require("../src/controllers/authController");
const auth = require("../src/middleware/authMiddleware");
const requireEmailVerified = require("../src/middleware/emailVerificationMiddleware");
const authRoutes = require("../src/routes/authRoutes");
const chatRoutes = require("../src/routes/chatRoutes");
const digishopRoutes = require("../src/routes/digishopRoutes");
const favoriteRoutes = require("../src/routes/favoriteRoutes");
const listingRoutes = require("../src/routes/listingRoutes");
const orderRoutes = require("../src/routes/orderRoutes");
const paymentRoutes = require("../src/routes/paymentRoutes");
const socketConfig = require("../src/config/socket");
const { authenticateSocket, registerSocketCapabilities } = socketConfig;
const { createNotification } = require("../src/services/notificationService");
const { chatUserRoom, notificationUserRoom } = require("../src/socket/rooms");
const { signAccessToken } = require("../src/utils/generateToken");

const invokeMiddleware = (middleware, req = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      resolve({ nextCalled: false, payload, statusCode: this.statusCode });
      return payload;
    },
  };
  middleware(req, res, (error) => {
    if (error) reject(error);
    else resolve({ nextCalled: true, req, statusCode: res.statusCode });
  });
});

const invokeController = (controller, req) => new Promise((resolve, reject) => {
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

const routeHandles = (router, method, path) => {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method],
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} should exist`);
  return layer.route.stack.map((routeLayer) => routeLayer.handle);
};

test("normal authentication remains permissive and exposes verification state", async () => {
  const originalFindById = User.findById;
  User.findById = () => ({
    select: async () => ({
      _id: { toString: () => "user-1" },
      accountStatus: "active",
      email: "buyer@example.com",
      hasShop: false,
      isEmailVerified: false,
      isKycVerified: false,
      roles: {},
      username: "buyer",
    }),
  });

  try {
    const token = signAccessToken({ _id: { toString: () => "user-1" }, roles: {} });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const result = await invokeMiddleware(auth, req);
    assert.equal(result.nextCalled, true);
    assert.equal(req.user.isEmailVerified, false);
  } finally {
    User.findById = originalFindById;
  }
});

test("verification middleware blocks only unverified users", async () => {
  const blocked = await invokeMiddleware(requireEmailVerified, {
    user: { isEmailVerified: false },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.payload.error, "Email verification required for this action");

  const allowed = await invokeMiddleware(requireEmailVerified, {
    user: { isEmailVerified: true },
  });
  assert.equal(allowed.nextCalled, true);
});

test("restricted REST actions use the verification gate before uploads or controllers", () => {
  const restrictedRoutes = [
    [chatRoutes, "get", "/"],
    [chatRoutes, "post", "/"],
    [chatRoutes, "put", "/messages/:messageId/reaction"],
    [chatRoutes, "put", "/:conversationId/read"],
    [chatRoutes, "put", "/:conversationId/reactions/read"],
    [chatRoutes, "get", "/:conversationId"],
    [digishopRoutes, "post", "/"],
    [listingRoutes, "post", "/"],
    [listingRoutes, "put", "/:id"],
    [orderRoutes, "post", "/"],
    [paymentRoutes, "post", "/initialize"],
    [paymentRoutes, "post", "/promotions/initialize"],
  ];

  restrictedRoutes.forEach(([router, method, path]) => {
    const handles = routeHandles(router, method, path);
    assert.ok(handles.includes(requireEmailVerified), `${method.toUpperCase()} ${path}`);
    assert.ok(handles.indexOf(requireEmailVerified) <= 2, `${method.toUpperCase()} ${path} should gate early`);
  });
});

test("favorites, browsing, and transaction recovery remain outside the verification gate", () => {
  [
    [favoriteRoutes, "get", "/"],
    [favoriteRoutes, "post", "/:targetType/:targetId"],
    [listingRoutes, "get", "/"],
    [listingRoutes, "get", "/:id"],
    [orderRoutes, "get", "/:id"],
    [paymentRoutes, "get", "/verify/:reference"],
    [paymentRoutes, "delete", "/:reference"],
  ].forEach(([router, method, path]) => {
    assert.equal(routeHandles(router, method, path).includes(requireEmailVerified), false);
  });
});

test("active unverified accounts can log in normally", async () => {
  const originals = {
    compare: bcrypt.compare,
    findById: User.findById,
    findOne: User.findOne,
    shadowFindOneAndUpdate: ShadowProfile.findOneAndUpdate,
  };
  const user = {
    _id: { toString: () => "user-1" },
    accountStatus: "active",
    email: "buyer@example.com",
    emailVerifyExpires: new Date(Date.now() + 60_000),
    emailVerifyToken: "hashed-current-token",
    isEmailVerified: false,
    refreshTokens: [],
    roles: {},
    save: async () => undefined,
  };
  const safeUser = { _id: user._id, email: user.email, isEmailVerified: false };

  bcrypt.compare = async () => true;
  User.findOne = () => ({ select: async () => user });
  User.findById = () => ({ select: async () => safeUser });
  ShadowProfile.findOneAndUpdate = async () => ({});

  try {
    const result = await invokeController(authController.login, {
      body: { identifier: user.email, password: "Strong1!" },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.data.user.isEmailVerified, false);
    assert.ok(result.payload.data.tokens.accessToken);
    assert.equal(user.refreshTokens.length, 1);
  } finally {
    bcrypt.compare = originals.compare;
    User.findById = originals.findById;
    User.findOne = originals.findOne;
    ShadowProfile.findOneAndUpdate = originals.shadowFindOneAndUpdate;
  }
});

test("login refreshes a verification link only when its token is missing or expired", () => {
  const now = Date.now();
  assert.equal(authController.needsFreshEmailVerification({ isEmailVerified: true }, now), false);
  assert.equal(authController.needsFreshEmailVerification({ isEmailVerified: false }, now), true);
  assert.equal(authController.needsFreshEmailVerification({
    emailVerifyExpires: new Date(now - 1),
    emailVerifyToken: "expired",
    isEmailVerified: false,
  }, now), true);
  assert.equal(authController.needsFreshEmailVerification({
    emailVerifyExpires: new Date(now + 1),
    emailVerifyToken: "current",
    isEmailVerified: false,
  }, now), false);
});

test("verification resend is an authenticated, rate-limited route", () => {
  const handles = routeHandles(authRoutes, "post", "/resend-verification");
  assert.equal(handles.length >= 3, true);
  assert.equal(handles[0], auth);
});

test("socket capabilities retain notifications but expose chat only after verification", async () => {
  const originalFindById = User.findById;
  const token = signAccessToken({ _id: { toString: () => "user-1" }, roles: {} });
  const makeSocket = () => {
    const joined = [];
    const handlers = [];
    return {
      handshake: { auth: { token } },
      handlers,
      join(room) { joined.push(room); },
      joined,
      on(event) { handlers.push(event); },
    };
  };

  try {
    const unverifiedSocket = makeSocket();
    User.findById = () => ({
      select: async () => ({
        _id: { toString: () => "user-1" },
        accountStatus: "active",
        isEmailVerified: false,
        roles: {},
      }),
    });
    const unverifiedError = await new Promise((resolve) => authenticateSocket(unverifiedSocket, resolve));
    assert.equal(unverifiedError, undefined);
    assert.equal(unverifiedSocket.user.isEmailVerified, false);
    assert.equal(registerSocketCapabilities({}, unverifiedSocket), false);
    assert.deepEqual(unverifiedSocket.joined, [notificationUserRoom("user-1")]);
    assert.deepEqual(unverifiedSocket.handlers, []);

    const verifiedSocket = makeSocket();
    User.findById = () => ({
      select: async () => ({
        _id: { toString: () => "user-1" },
        accountStatus: "active",
        isEmailVerified: true,
        roles: {},
      }),
    });
    const allowedError = await new Promise((resolve) => authenticateSocket(verifiedSocket, resolve));
    assert.equal(allowedError, undefined);
    assert.equal(verifiedSocket.user.isEmailVerified, true);
    assert.equal(registerSocketCapabilities({}, verifiedSocket), true);
    assert.deepEqual(verifiedSocket.joined, [
      notificationUserRoom("user-1"),
      chatUserRoom("user-1"),
    ]);
    assert.ok(verifiedSocket.handlers.includes("send-message"));
    assert.ok(verifiedSocket.handlers.includes("join_conversation"));
  } finally {
    User.findById = originalFindById;
  }
});

test("system and chat notifications emit to isolated personal rooms", async () => {
  const originalCreate = Notification.create;
  const originalGetIO = socketConfig.getIO;
  const rooms = [];
  Notification.create = async (payload) => ({ _id: "notification-1", ...payload });
  socketConfig.getIO = () => ({
    to(room) {
      rooms.push(room);
      return { emit() {} };
    },
  });

  try {
    await createNotification({
      body: "System body",
      title: "System title",
      type: "system",
      userId: "user-1",
    });
    assert.deepEqual(rooms, [
      notificationUserRoom("user-1"),
      notificationUserRoom("user-1"),
    ]);
    assert.equal(rooms.includes(chatUserRoom("user-1")), false);

    rooms.length = 0;
    await createNotification({
      body: "Chat body",
      title: "Chat title",
      type: "chat",
      userId: "user-1",
    });
    assert.deepEqual(rooms, [
      chatUserRoom("user-1"),
      chatUserRoom("user-1"),
    ]);
    assert.equal(rooms.includes(notificationUserRoom("user-1")), false);
  } finally {
    Notification.create = originalCreate;
    socketConfig.getIO = originalGetIO;
  }
});
