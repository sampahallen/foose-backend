const mongoose = require("mongoose");
const { Schema } = mongoose;

const siteAnalyticsEventSchema = new Schema(
  {
    source: {
      type: String,
      enum: ["marketplace", "admin", "backend", "unknown"],
      default: "unknown",
      index: true,
    },
    type: {
      type: String,
      enum: [
        "page_view",
        "js_error",
        "unhandled_rejection",
        "api_failure",
        "resource_error",
        "custom",
      ],
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: ["info", "warning", "error", "critical"],
      default: "info",
      index: true,
    },
    message: {
      type: String,
      trim: true,
      maxlength: 600,
      default: "",
    },
    path: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
    },
    url: {
      type: String,
      trim: true,
      maxlength: 600,
      default: "",
    },
    endpoint: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
    },
    method: {
      type: String,
      trim: true,
      maxlength: 16,
      default: "",
    },
    statusCode: Number,
    userAgent: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

siteAnalyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 45 });
siteAnalyticsEventSchema.index({ createdAt: -1, type: 1, severity: 1 });

module.exports = mongoose.model("SiteAnalyticsEvent", siteAnalyticsEventSchema);
