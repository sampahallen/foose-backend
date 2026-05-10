const mongoose = require("mongoose");
const { Schema } = mongoose;

const kycSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    idType: {
      type: String,
      enum: ["Ghana Card", "Passport", "Driving License"],
      required: true,
    },
    idNo: {
      type: String,
      required: true,
      trim: true,
    },
    dob: {
      type: String,
      required: true,
    },
    idImgUrl: {
      type: String,
      required: true,
    },
    selfieImgUrl: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["not_submitted", "pending", "approved", "rejected"],
      default: "not_submitted",
    },
    rejectionReason: {
      type: String,
      default: "",
    },
    submissionCount: {
      type: Number,
      default: 0,
    },
    submittedAt: Date,
    reviewedAt: Date,
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("KYC", kycSchema);
