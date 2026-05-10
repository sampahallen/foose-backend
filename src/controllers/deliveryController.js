const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");
const { estimateDeliveryFee } = require("../services/deliveryService");

exports.estimate = asyncHandler(async (req, res) => {
  const fee = estimateDeliveryFee({
    region: req.query.region,
    method: req.query.method || "delivery",
  });

  return success(
    res,
    {
      region: req.query.region,
      city: req.query.city,
      fee,
      currency: "GHS",
    },
    "Delivery fee estimated",
  );
});
