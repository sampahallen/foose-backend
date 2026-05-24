const DigiShop = require("../models/DigiShop");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const slugify = require("../utils/slugify");
const { success } = require("../utils/apiResponse");
const { sendDigiShopWelcomeEmail } = require("../services/emailService");
const { withCache, invalidate } = require("../utils/cache");

const firstFileUrl = (req, ...fieldNames) => {
  for (const fieldName of fieldNames) {
    const url = req.fileUrlMap?.[fieldName]?.[0];
    if (url) return url;
  }

  return undefined;
};

const payoutMethodFromBody = (body) => ({
  type: body.payoutMethodType || "mobile_money",
  accountName: body.payoutAccountName || "",
  provider: body.payoutProvider || "",
  accountNumber: body.payoutAccountNumber || "",
  bankName: body.payoutBankName || "",
  branch: body.payoutBranch || "",
});

const makeUniqueSlug = async (shopName) => {
  const base = slugify(shopName) || "digishop";
  let slug = base;
  let suffix = 1;

  while (await DigiShop.exists({ slug })) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }

  return slug;
};

exports.createShop = asyncHandler(async (req, res) => {
  const existingShop = await DigiShop.findOne({ ownerId: req.user.id });

  if (existingShop) {
    throw httpError(409, "You already have a DigiShop");
  }

  const user = await User.findById(req.user.id);
  const shop = await DigiShop.create({
    ownerId: req.user.id,
    shopName: req.body.shopName,
    slug: await makeUniqueSlug(req.body.shopName),
    bio: req.body.bio,
    logoUrl: firstFileUrl(req, "logo", "logoImage"),
    bannerUrl: firstFileUrl(req, "banner", "bannerImage"),
    category: req.body.category || "both",
    socialLinks: {
      instagram: req.body.instagram || "",
      whatsapp: req.body.whatsapp || "",
    },
    payoutMethod: payoutMethodFromBody(req.body),
  });

  user.hasShop = true;
  await user.save();
  await sendDigiShopWelcomeEmail(user, shop);

  return success(res, { shop }, "DigiShop created", 201);
});

exports.getMyShop = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id });

  if (!shop) {
    throw httpError(404, "DigiShop not found");
  }

  return success(res, { shop }, "DigiShop loaded");
});

exports.updateMyShop = asyncHandler(async (req, res) => {
  const shop = await DigiShop.findOne({ ownerId: req.user.id });

  if (!shop) {
    throw httpError(404, "DigiShop not found");
  }

  ["shopName", "bio", "category"].forEach((field) => {
    if (req.body[field] !== undefined) shop[field] = req.body[field];
  });

  const logoUrl = firstFileUrl(req, "logo", "logoImage");
  const bannerUrl = firstFileUrl(req, "banner", "bannerImage");

  if (logoUrl) shop.logoUrl = logoUrl;
  if (bannerUrl) shop.bannerUrl = bannerUrl;
  if (req.body.instagram !== undefined) {
    shop.socialLinks.instagram = req.body.instagram;
  }
  if (req.body.whatsapp !== undefined) {
    shop.socialLinks.whatsapp = req.body.whatsapp;
  }
  [
    "payoutMethodType",
    "payoutAccountName",
    "payoutProvider",
    "payoutAccountNumber",
    "payoutBankName",
    "payoutBranch",
  ].forEach((field) => {
    if (req.body[field] !== undefined) {
      shop.payoutMethod = payoutMethodFromBody({
        payoutMethodType: req.body.payoutMethodType || shop.payoutMethod?.type,
        payoutAccountName: req.body.payoutAccountName || shop.payoutMethod?.accountName,
        payoutProvider: req.body.payoutProvider || shop.payoutMethod?.provider,
        payoutAccountNumber: req.body.payoutAccountNumber || shop.payoutMethod?.accountNumber,
        payoutBankName: req.body.payoutBankName || shop.payoutMethod?.bankName,
        payoutBranch: req.body.payoutBranch || shop.payoutMethod?.branch,
      });
    }
  });

  await shop.save();
  await invalidate(`shop:${shop.slug}`);

  return success(res, { shop }, "DigiShop updated");
});

exports.getShopBySlug = asyncHandler(async (req, res) => {
  const shop = await withCache(`shop:${req.params.slug}`, 600, () =>
    DigiShop.findOne({ slug: req.params.slug })
      .populate("ownerId", "name username profilePhoto isKycVerified")
      .lean(),
  );

  if (!shop) {
    throw httpError(404, "DigiShop not found");
  }

  return success(res, { shop }, "DigiShop loaded");
});
