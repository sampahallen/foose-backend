const COLOR_VALUES = [
  "beige", "black", "blue", "brown", "burgundy", "cream", "cyan", "gold",
  "green", "gray", "ivory", "khaki", "multi", "navy", "olive", "orange",
  "pink", "purple", "red", "silver", "teal", "turquoise", "violet", "white", "yellow",
];

const effectiveListingColors = (listing) =>
  listing?.colors?.length ? listing.colors : listing?.color ? [listing.color] : [];

const normalizeListingColorFields = (input, currentListing) => {
  if (input.colors !== undefined) {
    input.color = input.colors[0];
  } else if (input.color !== undefined) {
    input.colors = [input.color];
  } else if (!currentListing && input.type === "retail") {
    input.color = "multi";
    input.colors = ["multi"];
  }
  return input;
};

const appendColorFilter = (filter, color) => {
  if (!color) return filter;
  filter.$and = [...(filter.$and || []), { $or: [{ colors: color }, { color }] }];
  return filter;
};

module.exports = { COLOR_VALUES, effectiveListingColors, normalizeListingColorFields, appendColorFilter };
