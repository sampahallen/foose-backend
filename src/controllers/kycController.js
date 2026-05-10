const KYC = require("../models/KYC");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const { success } = require("../utils/apiResponse");

const firstFileUrl = (req, ...fieldNames) => {
  for (const fieldName of fieldNames) {
    const url = req.fileUrlMap?.[fieldName]?.[0];
    if (url) return url;
  }

  return undefined;
};

const submissionPayload = (req, existingKyc) => {
  const idImgUrl =
    firstFileUrl(req, "idImg", "idImage") || req.body.idImgUrl || existingKyc?.idImgUrl;
  const selfieImgUrl =
    firstFileUrl(req, "selfie", "selfieImage") ||
    req.body.selfieImgUrl ||
    existingKyc?.selfieImgUrl;

  if (!idImgUrl || !selfieImgUrl) {
    throw httpError(422, "ID image and selfie image are required");
  }

  return {
    idType: req.body.idType,
    idNo: req.body.idNo,
    dob: req.body.dob,
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
