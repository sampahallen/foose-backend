const {
  DELIVERY_FEES,
  DEFAULT_DELIVERY_FEE,
} = require("../config/deliveryFees");

const estimateDeliveryFee = ({ region, method = "delivery" }) => {
  if (method === "pickup") return 0;

  const fee = DELIVERY_FEES[region];

  if (fee === undefined) {
    console.warn(`Unknown delivery region: ${region}`);
    return DEFAULT_DELIVERY_FEE;
  }

  return fee;
};

module.exports = {
  estimateDeliveryFee,
};
