const axios = require("axios");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const httpError = require("../utils/httpError");

const stateSecret = () =>
  process.env.OAUTH_STATE_SECRET ||
  process.env.JWT_ACCESS_SECRET ||
  process.env.ACCESS_TOKEN_SECRET ||
  "development_oauth_state_secret";

const cleanPath = (path) => {
  const value = String(path || "/").trim();
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
};

const isProduction = () => process.env.NODE_ENV === "production";

const requirePublicUrl = (name, fallback) => {
  const value = process.env[name]?.trim();
  if (value) return value.replace(/\/$/, "");
  if (!isProduction() && fallback) return fallback.replace(/\/$/, "");
  throw httpError(503, `${name} must be configured with a deployed public URL`);
};

const clientUrl = () => requirePublicUrl("CLIENT_URL", "http://localhost:5173");

const clientCallbackUrl = () => {
  if (process.env.CLIENT_AUTH_CALLBACK_URL?.trim()) return process.env.CLIENT_AUTH_CALLBACK_URL.trim();
  const basePath = (process.env.CLIENT_BASE_PATH || "").trim().replace(/^\/?/, "/").replace(/\/$/, "");
  return `${clientUrl()}${basePath}/auth/callback`;
};

const publicApiUrl = () => {
  const publicUrl = process.env.API_PUBLIC_URL?.trim() || process.env.SERVER_URL?.trim();
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  return requirePublicUrl("API_PUBLIC_URL", `http://localhost:${process.env.PORT || 5000}`);
};

const redirectUri = (provider) => {
  const envKey = provider === "google" ? "GOOGLE_OAUTH_REDIRECT_URI" : "APPLE_OAUTH_REDIRECT_URI";
  return process.env[envKey] || `${publicApiUrl()}/api/auth/oauth/${provider}/callback`;
};

const signState = (redirect) =>
  jwt.sign({ redirect: cleanPath(redirect) }, stateSecret(), { expiresIn: "10m" });

const readState = (state) => {
  try {
    const decoded = jwt.verify(state, stateSecret());
    return cleanPath(decoded.redirect);
  } catch {
    return "/";
  }
};

const requireEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw httpError(503, `${name} is not configured`);
  return value;
};

const makeUsername = async (seed) => {
  const normalized = String(seed || "foose_user")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16);
  const base = normalized.length >= 3 ? normalized : `foose_${normalized || "user"}`;

  for (let index = 0; index < 20; index += 1) {
    const suffix = index === 0 ? "" : String(index);
    const candidate = `${base}${suffix}`.slice(0, 20);
    const exists = await User.exists({ username: candidate });
    if (!exists) return candidate;
  }

  return `foose_${Date.now().toString(36)}`.slice(0, 20);
};

const linkProvider = (user, provider, providerId, email) => {
  const providers = user.authProviders || [];
  const exists = providers.some((item) => item.provider === provider && item.providerId === providerId);
  if (!exists) {
    providers.push({ provider, providerId, email: email || "" });
    user.authProviders = providers;
  }
};

const findOrCreateOAuthUser = async ({ provider, providerId, email, name, profilePhoto }) => {
  const normalizedEmail = email?.trim().toLowerCase();
  let user = await User.findOne({
    authProviders: { $elemMatch: { provider, providerId } },
  }).select("+authProviders +refreshTokens");

  if (!user && normalizedEmail) {
    user = await User.findOne({ email: normalizedEmail }).select("+authProviders +refreshTokens");
  }

  if (user) {
    linkProvider(user, provider, providerId, normalizedEmail);
    if (!user.profilePhoto && profilePhoto) user.profilePhoto = profilePhoto;
    if (normalizedEmail) user.isEmailVerified = true;
    await user.save();
    return user;
  }

  if (!normalizedEmail) {
    throw httpError(400, "This provider did not return an email address. Try another sign-in method.");
  }

  const passwordHash = await bcrypt.hash(`${provider}:${providerId}:${Date.now()}`, 12);
  const username = await makeUsername(normalizedEmail.split("@")[0] || name);

  return User.create({
    authProviders: [{ provider, providerId, email: normalizedEmail }],
    email: normalizedEmail,
    isEmailVerified: true,
    name: name?.trim() || normalizedEmail.split("@")[0],
    passwordHash,
    profilePhoto,
    username,
  });
};

const googleAuthorizationUrl = (redirect) => {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    include_granted_scopes: "true",
    prompt: "select_account",
    redirect_uri: redirectUri("google"),
    response_type: "code",
    scope: "openid email profile",
    state: signState(redirect),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};

const getGoogleProfile = async (code) => {
  const tokenResponse = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri("google"),
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );

  const profileResponse = await axios.get("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
  });

  return {
    email: profileResponse.data.email,
    name: profileResponse.data.name,
    profilePhoto: profileResponse.data.picture,
    provider: "google",
    providerId: profileResponse.data.sub,
  };
};

const appleClientSecret = () => {
  const privateKey = requireEnv("APPLE_OAUTH_PRIVATE_KEY").replace(/\\n/g, "\n");
  return jwt.sign(
    {
      aud: "https://appleid.apple.com",
      iss: requireEnv("APPLE_OAUTH_TEAM_ID"),
      sub: requireEnv("APPLE_OAUTH_CLIENT_ID"),
    },
    privateKey,
    {
      algorithm: "ES256",
      expiresIn: "5m",
      header: { alg: "ES256", kid: requireEnv("APPLE_OAUTH_KEY_ID") },
    },
  );
};

const appleAuthorizationUrl = (redirect) => {
  const params = new URLSearchParams({
    client_id: requireEnv("APPLE_OAUTH_CLIENT_ID"),
    redirect_uri: redirectUri("apple"),
    response_mode: "form_post",
    response_type: "code",
    scope: "name email",
    state: signState(redirect),
  });
  return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
};

const getAppleProfile = async (code, userPayload) => {
  const tokenResponse = await axios.post(
    "https://appleid.apple.com/auth/token",
    new URLSearchParams({
      client_id: requireEnv("APPLE_OAUTH_CLIENT_ID"),
      client_secret: appleClientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri("apple"),
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );

  const decoded = jwt.decode(tokenResponse.data.id_token) || {};
  let parsedUser = {};
  try {
    parsedUser = userPayload ? JSON.parse(userPayload) : {};
  } catch {
    parsedUser = {};
  }

  const fullName = [parsedUser.name?.firstName, parsedUser.name?.lastName].filter(Boolean).join(" ");

  return {
    email: decoded.email,
    name: fullName || decoded.email?.split("@")[0],
    provider: "apple",
    providerId: decoded.sub,
  };
};

module.exports = {
  appleAuthorizationUrl,
  clientCallbackUrl,
  clientUrl,
  findOrCreateOAuthUser,
  getAppleProfile,
  getGoogleProfile,
  googleAuthorizationUrl,
  publicApiUrl,
  readState,
};
