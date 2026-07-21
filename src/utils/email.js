const { domainToASCII } = require("node:url");
const { DISPOSABLE_EMAIL_DOMAINS } = require("../constants/disposableEmailDomains");

const disposableDomains = new Set(DISPOSABLE_EMAIL_DOMAINS);

const normalizeEmailDomain = (email) => {
  const normalizedEmail = String(email || "").normalize("NFKC").trim().toLowerCase();
  const separatorIndex = normalizedEmail.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === normalizedEmail.length - 1) return "";

  const unicodeDomain = normalizedEmail.slice(separatorIndex + 1).replace(/\.+$/, "");
  return domainToASCII(unicodeDomain).toLowerCase();
};

const isDisposableEmail = (email) => {
  let candidate = normalizeEmailDomain(email);

  while (candidate) {
    if (disposableDomains.has(candidate)) return true;
    const dotIndex = candidate.indexOf(".");
    if (dotIndex === -1) return false;
    candidate = candidate.slice(dotIndex + 1);
  }

  return false;
};

module.exports = {
  isDisposableEmail,
  normalizeEmailDomain,
};
