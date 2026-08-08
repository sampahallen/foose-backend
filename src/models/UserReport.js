const mongoose = require("mongoose");
const { USER_REPORT_REASONS, USER_REPORT_STATUSES } = require("../constants/userReports");

const { Schema } = mongoose;

const userReportSchema = new Schema(
  {
    reporterId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      immutable: true,
    },
    reportedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      immutable: true,
    },
    reason: {
      type: String,
      enum: USER_REPORT_REASONS,
      required: true,
      immutable: true,
    },
    details: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
      immutable: true,
      validate: {
        validator: function validateDetails(value) {
          return this.reason !== "other" || Boolean(value && value.trim().length > 0);
        },
        message: "Details are required when reason is 'other'",
      },
    },
    status: {
      type: String,
      enum: USER_REPORT_STATUSES,
      default: "open",
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
      index: true,
    },
    resolution: {
      resolverId: {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
      note: {
        type: String,
        trim: true,
        maxlength: 2000,
        default: "",
      },
      resolvedAt: Date,
    },
  },
  { timestamps: true },
);

userReportSchema.pre("validate", function rejectSelfReport() {
  if (this.reporterId && this.reportedUserId && String(this.reporterId) === String(this.reportedUserId)) {
    throw new Error("You cannot report yourself");
  }
});

userReportSchema.index(
  { reporterId: 1, reportedUserId: 1, isActive: 1 },
  {
    name: "user_report_one_active",
    partialFilterExpression: { isActive: true },
    unique: true,
  },
);
userReportSchema.index({ status: 1, createdAt: 1 }, { name: "user_report_review_queue" });

module.exports = mongoose.model("UserReport", userReportSchema);
