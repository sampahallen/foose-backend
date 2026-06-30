const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00233")) return `0${digits.slice(5)}`;
  if (digits.startsWith("233")) return `0${digits.slice(3)}`;
  return digits.startsWith("0") ? digits : `0${digits}`;
};

module.exports = { normalizePhone };
