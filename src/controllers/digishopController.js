const DigiShop = require("../models/DigiShop");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const httpError = require("../utils/httpError");
const slugify = require("../utils/slugify");
const { success } = require("../utils/apiResponse");
const { sendDigiShopWelcomeEmail } = require("../services/emailService");
const { withCache, invalidate, invalidatePattern } = require("../utils/cache");
const { normalizePhone } = require("../utils/phone");

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
  accountNumber: normalizePhone(body.payoutAccountNumber || ""),
  bankName: body.payoutBankName || "",
  branch: body.payoutBranch || "",
});

const shopLocationFromBody = (body, currentLocation = {}) => ({
  city: body.city !== undefined ? body.city : currentLocation.city || "",
  region: body.region !== undefined ? body.region : currentLocation.region || "",
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
    location: shopLocationFromBody(req.body),
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
  if (req.body.city !== undefined || req.body.region !== undefined) {
    shop.location = shopLocationFromBody(req.body, shop.location);
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
  await invalidate(`shop:${shop.slug}`, "listings:featured");
  await invalidatePattern("search:*");

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

exports.listShops = asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const filter = { isLive: true };

  if (req.query.category) filter.category = req.query.category;
  if (req.query.q) {
    const pattern = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ shopName: pattern }, { bio: pattern }];
  }

  const [shops, total] = await Promise.all([
    DigiShop.find(filter)
      .sort({ rating: -1, totalReviews: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("ownerId", "name username profilePhoto isKycVerified")
      .lean(),
    DigiShop.countDocuments(filter),
  ]);

  return success(res, {
    shops,
    total,
    page,
    pages: Math.ceil(total / limit),
  }, "DigiShops loaded");
});
