const path = require("path");
const multer = require("multer");
const { uploadBuffer } = require("../config/s3");

const bytes = (mb) => mb * 1024 * 1024;

const allowedImageTypes = ["image/jpeg", "image/png", "image/webp"];
const allowedVideoTypes = ["video/mp4", "video/webm", "video/quicktime"];

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

module.exports = {
  chatAttachments,
  listingImages,
  kycDocuments,
  shopImages,
  singleImage,
};
