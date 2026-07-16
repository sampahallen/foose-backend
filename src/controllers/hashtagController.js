const Hashtag = require("../models/Hashtag");
const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");
const { normalizeHashtag } = require("../utils/hashtags");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

exports.suggestHashtags = asyncHandler(async (req, res) => {
  const prefix = normalizeHashtag(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 20);
  const filter = prefix ? { name: new RegExp(`^${escapeRegex(prefix)}`) } : {};

  const hashtags = await Hashtag.find(filter)
    .select("name postCount -_id")
    .sort({ postCount: -1, name: 1 })
    .limit(limit)
    .lean();

  const suggestions = hashtags.map(({ name, postCount }) => ({
    hashtag: `#${name}`,
    name,
    postCount,
  }));

  return success(res, { suggestions }, "Hashtag suggestions loaded");
});
