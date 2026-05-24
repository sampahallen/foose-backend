const mongoose = require("mongoose");
const { Schema } = mongoose;

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-zA-Z0-9_]{3,20}$/,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    profilePhoto: String,
    location: {
      region: {
        type: String,
        trim: true,
        default: "",
      },
      city: {
        type: String,
        trim: true,
        default: "",
      },
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerifyToken: String,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    refreshTokens: {
      type: [String],
      default: [],
      select: false,
    },
    isKycVerified: {
      type: Boolean,
      default: false,
    },
    kycId: {
      type: Schema.Types.ObjectId,
      ref: "KYC",
    },
    hasShop: {
      type: Boolean,
      default: false,
    },
    wallet: {
      balance: {
        type: Number,
        default: 0,
        min: 0,
      },
      escrow: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
    following: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true },
);

module.exports = mongoose.model("User", userSchema);
