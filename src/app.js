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
const reviewRoutes = require("./routes/reviewRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const adminRoutes = require("./routes/adminRoutes");
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
app.use("/api/reviews", reviewRoutes);
app.use("/api/notifications", notificationRoutes);
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
  return error(res, err.message || "Server Error", statusCode, err.details);
});

module.exports = app;
