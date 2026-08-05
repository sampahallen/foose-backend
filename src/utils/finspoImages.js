const httpError = require("./httpError");

const MAX_FINSPO_IMAGES = 8;

const currentFinspoImages = (post) =>
  post.images?.length ? [...post.images] : [post.imageUrl].filter(Boolean);

const uploadedFinspoImages = (req) => [
  ...(req.fileUrlMap?.images || []),
  ...(req.fileUrlMap?.image || []),
];

const assertFinspoImageCount = (images) => {
  if (!images.length) throw httpError(422, "A Finspo post must have at least one image");
  if (images.length > MAX_FINSPO_IMAGES) {
    throw httpError(422, `A Finspo post can have at most ${MAX_FINSPO_IMAGES} images`);
  }
  return images;
};

const resolveFinspoImageOrder = ({ currentImages, imageOrder, uploadedImages }) => {
  let parsedOrder = imageOrder;
  if (typeof parsedOrder === "string") {
    try {
      parsedOrder = JSON.parse(parsedOrder);
    } catch {
      throw httpError(422, "Finspo image order is invalid");
    }
  }
  if (!Array.isArray(parsedOrder)) throw httpError(422, "Finspo image order is invalid");

  const currentImageSet = new Set(currentImages);
  const usedExistingImages = new Set();
  const usedNewIndexes = new Set();
  const nextImages = parsedOrder.map((entry) => {
    if (!entry || typeof entry !== "object") throw httpError(422, "Finspo image order is invalid");
    if (entry.type === "existing") {
      if (
        typeof entry.url !== "string" ||
        !currentImageSet.has(entry.url) ||
        usedExistingImages.has(entry.url)
      ) {
        throw httpError(422, "A retained Finspo image is invalid");
      }
      usedExistingImages.add(entry.url);
      return entry.url;
    }
    if (entry.type === "new") {
      if (
        !Number.isInteger(entry.index) ||
        entry.index < 0 ||
        entry.index >= uploadedImages.length ||
        usedNewIndexes.has(entry.index)
      ) {
        throw httpError(422, "Finspo image order references an invalid new image");
      }
      usedNewIndexes.add(entry.index);
      return uploadedImages[entry.index];
    }
    throw httpError(422, "Finspo image order is invalid");
  });

  if (usedNewIndexes.size !== uploadedImages.length) {
    throw httpError(422, "Every uploaded Finspo image must appear in the image order");
  }
  if (new Set(nextImages).size !== nextImages.length) {
    throw httpError(422, "Finspo images cannot be duplicated");
  }
  return assertFinspoImageCount(nextImages);
};

module.exports = {
  MAX_FINSPO_IMAGES,
  assertFinspoImageCount,
  currentFinspoImages,
  resolveFinspoImageOrder,
  uploadedFinspoImages,
};
