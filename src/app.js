const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const kycRoutes = require("./routes/kycRoutes");
const digishopRoutes = require("./routes/digishopRoutes");
const listingRoutes = require("./routes/listingRoutes");
const orderRoutes = require("./routes/orderRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const chatRoutes = require("./routes/chatRoutes");
const searchRoutes = require("./routes/searchRoutes");
const deliveryRoutes = require("./routes/deliveryRoutes");
const communityRoutes = require("./routes/communityRoutes");
const favoriteRoutes = require("./routes/favoriteRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const adminRoutes = require("./routes/adminRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const recommendationRoutes = require("./routes/recommendationRoutes");
const promotionRoutes = require("./routes/promotionRoutes");
const hashtagRoutes = require("./routes/hashtagRoutes");
const SiteAnalyticsEvent = require("./models/SiteAnalyticsEvent");
const { generalLimiter } = require("./middleware/rateLimitMiddleware");
const { success, error } = require("./utils/apiResponse");

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL || true,
    credentials: true,
  }),
);
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buffer) => {
      req.rawBody = buffer.toString();
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

app.get("/api/health", (req, res) => {
  return success(res, { service: "thrift-marketplace-api" }, "API is running");
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/digishops", digishopRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/delivery", deliveryRoutes);
app.use("/api/community", communityRoutes);
app.use("/api/favorites", favoriteRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/promotions", promotionRoutes);
app.use("/api/hashtags", hashtagRoutes);
app.use("/api/admin", adminRoutes);

app.use((req, res) => {
  return error(res, "Route not found", 404);
});

app.use((err, req, res, next) => {
  if (err.name === "MulterError") {
    return error(res, err.message, 400);
  }

  if (err.message?.startsWith("Unsupported file type")) {
    return error(res, err.message, 400);
  }

  if (err.name === "CastError") {
    return error(res, "Resource not found", 404);
  }

  if (err.code === 11000) {
    return error(res, "Duplicate resource", 409, err.keyValue);
  }

  const statusCode = err.statusCode || err.status || 500;
  if (statusCode >= 500) {
    void SiteAnalyticsEvent.create({
      endpoint: req.originalUrl,
      message: err.message || "Server Error",
      metadata: {
        code: err.code,
        name: err.name,
      },
      method: req.method,
      path: req.originalUrl,
      severity: "critical",
      source: "backend",
      statusCode,
      type: "api_failure",
      userAgent: req.get("user-agent") || "",
    }).catch(() => undefined);
  }

  return error(res, err.message || "Server Error", statusCode, err.details);
});

module.exports = app;
