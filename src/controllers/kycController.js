const KYC = require("../models/KYC");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");
const { normalizePhone } = require("../utils/phone");

const firstFileUrl = (req, fieldName) => {
  const url = req.fileUrlMap?.[fieldName]?.[0];
  return url || undefined;
};

const submissionPayload = (req, existingKyc) => {
  const idImgUrl = firstFileUrl(req, "idImg") || existingKyc?.idImgUrl;
  const selfieImgUrl = firstFileUrl(req, "selfie") || existingKyc?.selfieImgUrl;
  const phone = normalizePhone(req.body.phone || existingKyc?.phone || "");

  if (!idImgUrl || !selfieImgUrl) {
    throw httpError(
      422,
      "ID image and selfie are required. Upload both images (JPEG, PNG, or WebP), or when resubmitting after rejection you may omit a file to keep the previous image.",
    );
  }

  return {
    idType: req.body.idType,
    idNo: req.body.idNo,
    dob: req.body.dob,
    phone,
    phoneVerified: false,
    phoneOtpRequestedAt: undefined,
    phoneOtpVerifiedAt: undefined,
    idImgUrl,
    selfieImgUrl,
    status: "pending",
    rejectionReason: "",
    submittedAt: new Date(),
    reviewedAt: undefined,
    reviewedBy: undefined,
  };
};

exports.submitKyc = asyncHandler(async (req, res) => {
  const existingKyc = await KYC.findOne({ userId: req.user.id });

  if (existingKyc?.status === "pending") {
    throw httpError(409, "KYC submission is already pending review");
  }

  if (existingKyc && existingKyc.status !== "not_submitted") {
    throw httpError(409, "Use PUT /api/kyc to resubmit KYC");
  }

  const payload = submissionPayload(req, existingKyc);
  const kyc = await KYC.findOneAndUpdate(
    { userId: req.user.id },
    {
      $set: payload,
      $setOnInsert: { userId: req.user.id },
      $inc: { submissionCount: 1 },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );

  await User.findByIdAndUpdate(req.user.id, {
    isKycVerified: false,
    kycId: kyc._id,
    ...(kyc.phone ? { phone: kyc.phone } : {}),
  });

  return success(res, { kyc }, "KYC submitted for review", 201);
});

exports.resubmitKyc = asyncHandler(async (req, res) => {
  const kyc = await KYC.findOne({ userId: req.user.id });

  if (!kyc) {
    throw httpError(404, "No KYC record found. Submit KYC first.");
  }

  if (kyc.status === "pending") {
    throw httpError(409, "KYC submission is already pending review");
  }

  Object.assign(kyc, submissionPayload(req, kyc));
  kyc.submissionCount += 1;
  await kyc.save();

  await User.findByIdAndUpdate(req.user.id, {
    isKycVerified: false,
    kycId: kyc._id,
    ...(kyc.phone ? { phone: kyc.phone } : {}),
  });

  return success(res, { kyc }, "KYC resubmitted for review");
});

exports.getMyKyc = asyncHandler(async (req, res) => {
  const kyc = await KYC.findOne({ userId: req.user.id });

  return success(
    res,
    {
      kyc: kyc || {
        userId: req.user.id,
        status: "not_submitted",
        submissionCount: 0,
      },
    },
    "KYC status loaded",
  );
});
