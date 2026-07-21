const packageDomains = require("disposable-email-domains");
const packageWildcardDomains = require("disposable-email-domains/wildcard");

// Keep confirmed gaps here while the upstream offline dataset catches up.
// The matcher also blocks subdomains of every entry.
const LOCAL_DISPOSABLE_EMAIL_DOMAIN_OVERRIDES = Object.freeze([
  "1secmail.com",
  "dropmail.me",
  "emailnator.com",
  "mail.tm",
  "tempmailo.com",
]);

const DISPOSABLE_EMAIL_DOMAINS = Object.freeze(
  Array.from(new Set([
    ...packageDomains,
    ...packageWildcardDomains,
    ...LOCAL_DISPOSABLE_EMAIL_DOMAIN_OVERRIDES,
  ].map((domain) => String(domain).trim().toLowerCase()).filter(Boolean))),
);

module.exports = {
  DISPOSABLE_EMAIL_DOMAINS,
  LOCAL_DISPOSABLE_EMAIL_DOMAIN_OVERRIDES,
};
