const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const GalleryPost = require("../src/models/GalleryPost");
const {
  MAX_FINSPO_IMAGES,
  assertFinspoImageCount,
  currentFinspoImages,
  resolveFinspoImageOrder,
  uploadedFinspoImages,
} = require("../src/utils/finspoImages");

test("GalleryPost accepts one to eight ordered images and preserves the cover field", () => {
  const valid = new GalleryPost({
    imageUrl: "one.jpg",
    images: Array.from({ length: MAX_FINSPO_IMAGES }, (_, index) => `${index}.jpg`),
    userId: new mongoose.Types.ObjectId(),
  });
  assert.equal(valid.validateSync(), undefined);
  assert.equal(valid.imageUrl, "one.jpg");

  const invalid = new GalleryPost({
    imageUrl: "one.jpg",
    images: Array.from({ length: MAX_FINSPO_IMAGES + 1 }, (_, index) => `${index}.jpg`),
    userId: new mongoose.Types.ObjectId(),
  });
  assert.match(invalid.validateSync().errors.images.message, /between 1 and 8 images/);
});

test("legacy Finspo posts normalize to their singular cover image", () => {
  assert.deepEqual(currentFinspoImages({ imageUrl: "legacy.jpg" }), ["legacy.jpg"]);
  assert.deepEqual(
    currentFinspoImages({ imageUrl: "cover.jpg", images: ["first.jpg", "second.jpg"] }),
    ["first.jpg", "second.jpg"],
  );
});

test("multipart uploads include ordered plural images and the legacy singular field", () => {
  assert.deepEqual(uploadedFinspoImages({
    fileUrlMap: {
      image: ["legacy.jpg"],
      images: ["one.jpg", "two.jpg"],
    },
  }), ["one.jpg", "two.jpg", "legacy.jpg"]);
});

test("image-order manifests can interleave retained and newly uploaded images", () => {
  const resolved = resolveFinspoImageOrder({
    currentImages: ["old-one.jpg", "old-two.jpg"],
    imageOrder: JSON.stringify([
      { type: "new", index: 1 },
      { type: "existing", url: "old-one.jpg" },
      { type: "new", index: 0 },
    ]),
    uploadedImages: ["new-one.jpg", "new-two.jpg"],
  });

  assert.deepEqual(resolved, ["new-two.jpg", "old-one.jpg", "new-one.jpg"]);
});

test("image-order manifests reject foreign, duplicate, missing, empty, and excessive media", () => {
  const invalidOrders = [
    [{ type: "existing", url: "foreign.jpg" }],
    [{ type: "new", index: 0 }, { type: "new", index: 0 }],
    [{ type: "existing", url: "old.jpg" }],
    [],
  ];
  const uploads = [["new.jpg"], ["new.jpg"], ["new.jpg"], []];

  invalidOrders.forEach((imageOrder, index) => {
    assert.throws(
      () => resolveFinspoImageOrder({
        currentImages: ["old.jpg"],
        imageOrder,
        uploadedImages: uploads[index],
      }),
      (error) => error.statusCode === 422,
    );
  });

  assert.throws(
    () => assertFinspoImageCount(Array.from({ length: 9 }, (_, index) => `${index}.jpg`)),
    (error) => error.statusCode === 422,
  );
});
