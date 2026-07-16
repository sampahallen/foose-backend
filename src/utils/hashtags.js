const MAX_HASHTAGS = 10;
const MAX_HASHTAG_LENGTH = 32;

const normalizeHashtag = (value) =>
  String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, MAX_HASHTAG_LENGTH);

const normalizeHashtags = (value) => {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,]+/);

  return Array.from(new Set(values.map(normalizeHashtag).filter(Boolean))).slice(0, MAX_HASHTAGS);
};

module.exports = {
  MAX_HASHTAGS,
  MAX_HASHTAG_LENGTH,
  normalizeHashtag,
  normalizeHashtags,
};
