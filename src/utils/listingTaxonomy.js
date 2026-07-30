const LISTING_TAXONOMY = {
  Clothing: {
    fields: ["brand", "size", "gender", "material", "fit"],
    subcategories: [
      "Outerwear", "Tops & Shirts", "Hoodies & Sweatshirts", "Sweaters & Knits",
      "Dresses", "Skirts", "Jeans", "Trousers & Shorts", "Sportswear", "Workwear",
      "Other Clothing",
    ],
  },
  Footwear: {
    fields: ["brand", "size", "gender", "material"],
    subcategories: ["Sneakers", "Boots", "Sandals & Slides", "Other Footwear"],
  },
  Bags: {
    fields: ["brand", "size", "material"],
    subcategories: ["Handbags", "Backpacks", "Totes", "Crossbody & Shoulder Bags", "Travel Bags", "Other Bags"],
  },
  Accessories: {
    fields: ["brand", "size", "material"],
    subcategories: ["Hats & Caps", "Belts", "Jewelry & Watches", "Sunglasses", "Other Accessories"],
    fieldOverrides: {
      "Jewelry & Watches": ["brand", "material"],
      Sunglasses: ["brand", "material"],
    },
  },
  "Traditional & Fabrics": {
    fields: ["size", "gender", "material", "pattern"],
    subcategories: ["Traditional Wear & Prints", "Fabric & Textiles"],
    fieldOverrides: {
      "Fabric & Textiles": ["size", "material", "pattern"],
    },
  },
  Other: {
    fields: ["brand", "size", "gender", "material"],
    subcategories: [],
  },
};

const LEGACY_CATEGORY_MAP = {
  Outerwear: ["Clothing", "Outerwear"],
  "T-Shirts": ["Clothing", "Tops & Shirts"],
  Shirts: ["Clothing", "Tops & Shirts"],
  "Hoodies & Sweatshirts": ["Clothing", "Hoodies & Sweatshirts"],
  "Sweaters & Knits": ["Clothing", "Sweaters & Knits"],
  Dresses: ["Clothing", "Dresses"],
  Skirts: ["Clothing", "Skirts"],
  Jeans: ["Clothing", "Jeans"],
  Trousers: ["Clothing", "Trousers & Shorts"],
  Shorts: ["Clothing", "Trousers & Shorts"],
  Sportswear: ["Clothing", "Sportswear"],
  Workwear: ["Clothing", "Workwear"],
  Kids: ["Clothing", "Other Clothing"],
  Sneakers: ["Footwear", "Sneakers"],
  Boots: ["Footwear", "Boots"],
  "Sandals & Slides": ["Footwear", "Sandals & Slides"],
  Bags: ["Bags", "Other Bags"],
  "Hats & Caps": ["Accessories", "Hats & Caps"],
  Belts: ["Accessories", "Belts"],
  "Jewelry & Watches": ["Accessories", "Jewelry & Watches"],
  Sunglasses: ["Accessories", "Sunglasses"],
  Accessories: ["Accessories", "Other Accessories"],
  "Traditional & Prints": ["Traditional & Fabrics", "Traditional Wear & Prints"],
  "Fabric & Textiles": ["Traditional & Fabrics", "Fabric & Textiles"],
  Vintage: ["Other", ""],
  Designer: ["Other", ""],
  "Wholesale Bales": ["Other", ""],
};

const LEGACY_CATEGORY_HASHTAGS = { Designer: "designer", Vintage: "vintage" };

const ATTRIBUTE_OPTIONS = {
  material: new Set([
    "cotton", "denim", "leather", "faux-leather", "wool", "polyester", "linen",
    "silk", "canvas", "rubber", "metal", "wood", "mixed", "other",
  ]),
  fit: new Set(["slim", "regular", "relaxed", "oversized", "tailored"]),
  pattern: new Set(["solid", "striped", "checked", "floral", "graphic", "animal", "geometric", "traditional-print", "other"]),
  baleGrade: new Set(["premium", "grade-a", "grade-b", "mixed"]),
};

const LISTING_ATTRIBUTE_KEYS = Object.keys(ATTRIBUTE_OPTIONS);
const LEGACY_FIELD_KEYS = ["brand", "size", "gender"];
const LISTING_CATEGORIES = Object.keys(LISTING_TAXONOMY);

const categoryFields = (category, subcategory, type) => {
  const definition = LISTING_TAXONOMY[category];
  const fields = definition?.fieldOverrides?.[subcategory] || definition?.fields || [];
  return type === "wholesale" ? [...new Set([...fields, "baleGrade"])] : fields;
};

const normalizeCategorySelection = (category, subcategory) => {
  const rawCategory = String(category || "").trim();
  const rawSubcategory = String(subcategory || "").trim();
  const legacy = LEGACY_CATEGORY_MAP[rawCategory];
  const canonicalCategory = legacy?.[0] || rawCategory;
  const canonicalSubcategory = legacy?.[1] || rawSubcategory;
  const definition = LISTING_TAXONOMY[canonicalCategory];

  return {
    category: canonicalCategory,
    subcategory: definition?.subcategories.includes(canonicalSubcategory) ? canonicalSubcategory : "",
    validCategory: Boolean(definition),
    validSubcategory: !rawSubcategory || Boolean(definition?.subcategories.includes(canonicalSubcategory)),
    legacyHashtag: LEGACY_CATEGORY_HASHTAGS[rawCategory],
    wasLegacy: Boolean(legacy),
  };
};

const isSupportedCategory = (category) => Boolean(LISTING_TAXONOMY[String(category || "").trim()]);

const parseAttributes = (value) => {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Listing attributes must be an object");
    }
    return parsed;
  } catch (error) {
    if (error.message === "Listing attributes must be an object") throw error;
    throw new Error("Listing attributes must be valid JSON");
  }
};

const normalizeCategoryFields = (
  input,
  category,
  { replaceAttributes = false, subcategory, type } = {},
) => {
  const fields = new Set(categoryFields(category, subcategory, type));

  LEGACY_FIELD_KEYS.forEach((field) => {
    if (!fields.has(field)) input[field] = undefined;
  });

  if (input.attributes === undefined && !replaceAttributes) return input;

  const source = input.attributes || {};
  const unknownKeys = Object.keys(source).filter((key) => !LISTING_ATTRIBUTE_KEYS.includes(key));
  if (unknownKeys.length) throw new Error(`Unknown listing attribute: ${unknownKeys[0]}`);

  const attributes = {};
  LISTING_ATTRIBUTE_KEYS.forEach((key) => {
    const value = String(source[key] || "").trim().toLowerCase();
    if (!value || !fields.has(key)) return;
    if (!ATTRIBUTE_OPTIONS[key].has(value)) throw new Error(`Invalid ${key} listing attribute`);
    attributes[key] = value;
  });
  input.attributes = attributes;
  return input;
};

const applyCategoryFilter = (filter, category, subcategory) => {
  if (!category) {
    if (subcategory) filter.subcategory = subcategory;
    return filter;
  }
  const normalized = normalizeCategorySelection(category, subcategory);
  if (!normalized.validCategory) {
    filter.category = category;
    return filter;
  }
  filter.category = normalized.category;
  if (normalized.subcategory) filter.subcategory = normalized.subcategory;
  if (normalized.legacyHashtag) filter.hashtags = normalized.legacyHashtag;
  return filter;
};

module.exports = {
  ATTRIBUTE_OPTIONS,
  LEGACY_CATEGORY_HASHTAGS,
  LEGACY_CATEGORY_MAP,
  LISTING_ATTRIBUTE_KEYS,
  LISTING_CATEGORIES,
  LISTING_TAXONOMY,
  applyCategoryFilter,
  categoryFields,
  isSupportedCategory,
  normalizeCategoryFields,
  normalizeCategorySelection,
  parseAttributes,
};
