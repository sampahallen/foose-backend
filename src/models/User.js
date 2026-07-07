const mongoose = require("mongoose");
const { ROLE_KEYS, USER_ROLES, normalizeRoles } = require("../constants/roles");
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
      match: /^[a-zA-Z0-9_.]{3,20}$/,
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
    bio: {
      type: String,
      trim: true,
      maxlength: 280,
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
    roles: {
      [ROLE_KEYS.STANDARD_USER]: {
        type: Number,
        enum: [USER_ROLES.STANDARD_USER],
        default: USER_ROLES.STANDARD_USER,
      },
      [ROLE_KEYS.KYC_REVIEWER]: {
        type: Number,
        enum: [USER_ROLES.KYC_REVIEWER],
      },
      [ROLE_KEYS.COMMUNITY_MODERATOR]: {
        type: Number,
        enum: [USER_ROLES.COMMUNITY_MODERATOR],
      },
      [ROLE_KEYS.DISPUTE_RESOLVER]: {
        type: Number,
        enum: [USER_ROLES.DISPUTE_RESOLVER],
      },
      [ROLE_KEYS.SUPER_ADMIN]: {
        type: Number,
        enum: [USER_ROLES.SUPER_ADMIN],
      },
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerifyToken: String,
    emailVerifyExpires: Date,
    accountStatus: {
      type: String,
      enum: ["active", "deactivated", "deleted"],
      default: "active",
      index: true,
    },
    deactivatedAt: Date,
    scheduledDeletionAt: Date,
    deletedAt: Date,
    deletedEmail: {
      type: String,
      select: false,
    },
    deletedUsername: {
      type: String,
      select: false,
    },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    refreshTokens: {
      type: [String],
      default: [],
      select: false,
    },
    authProviders: {
      type: [
        {
          provider: {
            type: String,
            enum: ["google", "apple"],
            required: true,
          },
          providerId: {
            type: String,
            required: true,
          },
          email: {
            type: String,
            lowercase: true,
            trim: true,
            default: "",
          },
        },
      ],
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

userSchema.pre("init", (document) => {
  document.roles = normalizeRoles(document.roles, document.role);
  delete document.role;
});

module.exports = mongoose.model("User", userSchema);
