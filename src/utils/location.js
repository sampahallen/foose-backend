const normalizedText = (value) =>
  String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");

const normalizeLocation = (location = {}) => ({
  city: normalizedText(location?.city),
  region: normalizedText(location?.region),
});

const mergeLocation = (preferred = {}, fallback = {}) => {
  const preferredLocation = normalizeLocation(preferred);
  const fallbackLocation = normalizeLocation(fallback);

  return {
    city: preferredLocation.city || fallbackLocation.city,
    region: preferredLocation.region || fallbackLocation.region,
  };
};

const hasCompleteLocation = (location) => {
  const normalized = normalizeLocation(location);
  return Boolean(normalized.city && normalized.region);
};

const locationLabel = (location) => {
  const normalized = normalizeLocation(location);
  return [normalized.city, normalized.region].filter(Boolean).join(", ");
};

const comparableText = (value) => normalizedText(value).toLowerCase();

const locationMatches = (location, value) => {
  const expected = comparableText(value);
  if (!expected) return false;

  const normalized = normalizeLocation(location);
  return [locationLabel(normalized), normalized.city, normalized.region]
    .some((candidate) => comparableText(candidate) === expected);
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const exactPattern = (value) => new RegExp(`^${escapeRegex(normalizedText(value))}$`, "i");

const locationMatchQuery = (value, path = "location") => {
  const normalized = normalizedText(value);
  if (!normalized) return null;

  const separatorIndex = normalized.indexOf(",");
  if (separatorIndex !== -1) {
    const city = normalized.slice(0, separatorIndex).trim();
    const region = normalized.slice(separatorIndex + 1).trim();

    if (city && region) {
      return {
        [`${path}.city`]: exactPattern(city),
        [`${path}.region`]: exactPattern(region),
      };
    }
  }

  const pattern = exactPattern(normalized);
  return {
    $or: [
      { [`${path}.city`]: pattern },
      { [`${path}.region`]: pattern },
    ],
  };
};

const incompleteLocationQuery = (path = "location") => ({
  $or: [
    { [`${path}.city`]: { $exists: false } },
    { [`${path}.city`]: "" },
    { [`${path}.region`]: { $exists: false } },
    { [`${path}.region`]: "" },
  ],
});

const appendQueryClause = (filter, clause) => {
  if (!clause) return filter;
  filter.$and = [...(filter.$and || []), clause];
  return filter;
};

const effectiveListingLocation = (listing) => {
  const shop = listing?.shopId && typeof listing.shopId === "object"
    ? listing.shopId
    : null;

  return mergeLocation(listing?.location, shop?.location);
};

module.exports = {
  appendQueryClause,
  effectiveListingLocation,
  hasCompleteLocation,
  incompleteLocationQuery,
  locationLabel,
  locationMatches,
  locationMatchQuery,
  mergeLocation,
  normalizeLocation,
};
