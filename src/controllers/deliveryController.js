const asyncHandler = require("../utils/asyncHandler");
const { success } = require("../utils/apiResponse");
const { estimateDeliveryFee } = require("../services/deliveryService");
const { DELIVERY_FEES } = require("../config/deliveryFees");
const { withCache } = require("../utils/cache");

exports.estimate = asyncHandler(async (req, res) => {
  const fees = await withCache("delivery:fees", 86400, async () => DELIVERY_FEES);
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
      fees,
      currency: "GHS",
    },
    "Delivery fee estimated",
  );
});
