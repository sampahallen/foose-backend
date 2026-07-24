const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { uploadBuffer, uploadPrivateBuffer } = require("../config/s3");

const bytes = (mb) => mb * 1024 * 1024;

const allowedImageTypes = ["image/jpeg", "image/png", "image/webp"];
const allowedVideoTypes = ["video/mp4", "video/webm", "video/quicktime"];

const detectedImageType = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return null;

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
};

const fileFilter = (allowedTypes) => (req, file, cb) => {
  if (!file.originalname) {
    return cb(null, false);
  }

  if (allowedTypes.includes(file.mimetype)) {
    return cb(null, true);
  }

  cb(new Error(`Unsupported file type: ${file.mimetype}`));
};

const upload = (limitMb, allowedTypes = allowedImageTypes) =>
  multer({
    storage: multer.memoryStorage(),
    fileFilter: fileFilter(allowedTypes),
    limits: { fileSize: bytes(limitMb) },
  });

const sanitizeName = (name) =>
  path
    .basename(name, path.extname(name))
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .slice(0, 40);

const uploadToS3 =
  (folder) =>
  async (req, res, next) => {
    try {
      const files = [];

      if (Array.isArray(req.files)) {
        files.push(...req.files);
      } else if (req.files && typeof req.files === "object") {
        Object.values(req.files).forEach((fileList) => files.push(...fileList));
      } else if (req.file) {
        files.push(req.file);
      }

      req.fileUrls = [];
      req.fileUrlMap = {};
      req.fileUploads = [];

      for (const file of files) {
        const extension = path.extname(file.originalname).toLowerCase() || ".jpg";
        const safeName = sanitizeName(file.originalname) || "upload";
        const key = `${folder}/${Date.now()}-${Math.round(
          Math.random() * 1e9,
        )}-${safeName}${extension}`;
        const url = await uploadBuffer({
          buffer: file.buffer,
          mimetype: file.mimetype,
          key,
        });

        req.fileUrls.push(url);
        req.fileUploads.push({
          fieldname: file.fieldname,
          mimetype: file.mimetype,
          originalname: file.originalname,
          url,
        });
        req.fileUrlMap[file.fieldname] = req.fileUrlMap[file.fieldname] || [];
        req.fileUrlMap[file.fieldname].push(url);
      }

      next();
    } catch (error) {
      next(error);
    }
  };

const privateImageExtension = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const uploadPrivateImages =
  (folder) =>
  async (req, res, next) => {
    const uploadedKeys = [];

    try {
      const files = [];
      if (Array.isArray(req.files)) {
        files.push(...req.files);
      } else if (req.files && typeof req.files === "object") {
        Object.values(req.files).forEach((fileList) => files.push(...fileList));
      } else if (req.file) {
        files.push(req.file);
      }

      req.privateUploads = [];
      req.privateUploadMap = {};

      for (const file of files) {
        const actualType = detectedImageType(file.buffer);
        if (!actualType || actualType !== file.mimetype) {
          const error = new Error("Unsupported file type: image content does not match its declared type");
          error.statusCode = 400;
          throw error;
        }

        const key = `${folder}/${crypto.randomUUID()}${privateImageExtension[actualType]}`;
        await uploadPrivateBuffer({
          buffer: file.buffer,
          mimetype: actualType,
          key,
        });
        uploadedKeys.push(key);

        const uploaded = {
          fieldname: file.fieldname,
          key,
          mimetype: actualType,
          originalName: path.basename(file.originalname).slice(0, 180),
          size: file.size,
        };
        req.privateUploads.push(uploaded);
        req.privateUploadMap[file.fieldname] = req.privateUploadMap[file.fieldname] || [];
        req.privateUploadMap[file.fieldname].push(uploaded);
      }

      next();
    } catch (error) {
      error.uploadedPrivateKeys = uploadedKeys;
      next(error);
    }
  };

const listingImages = [
  upload(5).array("images", 6),
  uploadToS3("listings"),
];

/** KYC: multipart fields `idImg` + `selfie` → memory → S3 `kyc/` → URLs on `req.fileUrlMap` */
const kycDocuments = [
  upload(10).fields([
    { name: "idImg", maxCount: 1 },
    { name: "selfie", maxCount: 1 },
  ]),
  uploadToS3("kyc"),
];

const shopImages = [
  upload(5).fields([
    { name: "logo", maxCount: 1 },
    { name: "banner", maxCount: 1 },
    { name: "logoImage", maxCount: 1 },
    { name: "bannerImage", maxCount: 1 },
  ]),
  uploadToS3("digishops"),
];

const singleImage = (folder, fieldName = "image") => [
  upload(5).single(fieldName),
  uploadToS3(folder),
];

const chatAttachments = [
  upload(25, [...allowedImageTypes, ...allowedVideoTypes]).array("attachments", 8),
  uploadToS3("messages"),
];

const orderDispatchBill = [
  upload(5).single("billImage"),
  uploadPrivateImages("orders/transit-bills"),
];

const orderReportEvidence = [
  upload(5).array("evidence", 5),
  uploadPrivateImages("orders/report-evidence"),
];

module.exports = {
  chatAttachments,
  listingImages,
  kycDocuments,
  orderDispatchBill,
  orderReportEvidence,
  shopImages,
  singleImage,
};
