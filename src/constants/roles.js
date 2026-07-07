const USER_ROLES = Object.freeze({
  STANDARD_USER: 1001,
  KYC_REVIEWER: 2001,
  COMMUNITY_MODERATOR: 3001,
  DISPUTE_RESOLVER: 4001,
  SUPER_ADMIN: 9001,
});

const ROLE_KEYS = Object.freeze({
  STANDARD_USER: "standardUser",
  KYC_REVIEWER: "kycReviewer",
  COMMUNITY_MODERATOR: "communityModerator",
  DISPUTE_RESOLVER: "disputeResolver",
  SUPER_ADMIN: "superAdmin",
});

const ROLE_CODES_BY_KEY = Object.freeze({
  [ROLE_KEYS.STANDARD_USER]: USER_ROLES.STANDARD_USER,
  [ROLE_KEYS.KYC_REVIEWER]: USER_ROLES.KYC_REVIEWER,
  [ROLE_KEYS.COMMUNITY_MODERATOR]: USER_ROLES.COMMUNITY_MODERATOR,
  [ROLE_KEYS.DISPUTE_RESOLVER]: USER_ROLES.DISPUTE_RESOLVER,
  [ROLE_KEYS.SUPER_ADMIN]: USER_ROLES.SUPER_ADMIN,
});

const ROLE_KEYS_BY_CODE = Object.freeze(
  Object.fromEntries(Object.entries(ROLE_CODES_BY_KEY).map(([key, code]) => [code, key])),
);

const ROLE_LABELS = Object.freeze({
  [USER_ROLES.STANDARD_USER]: "Standard User",
  [USER_ROLES.KYC_REVIEWER]: "KYC Reviewer",
  [USER_ROLES.COMMUNITY_MODERATOR]: "Community Moderator",
  [USER_ROLES.DISPUTE_RESOLVER]: "Dispute Resolver",
  [USER_ROLES.SUPER_ADMIN]: "Super Admin",
});

const ROLE_VALUES = Object.freeze(Object.values(USER_ROLES));

const STAFF_ROLE_KEYS = Object.freeze([
  ROLE_KEYS.KYC_REVIEWER,
  ROLE_KEYS.COMMUNITY_MODERATOR,
  ROLE_KEYS.DISPUTE_RESOLVER,
  ROLE_KEYS.SUPER_ADMIN,
]);

const ROLE_GROUPS = Object.freeze({
  STAFF: Object.freeze([
    USER_ROLES.KYC_REVIEWER,
    USER_ROLES.COMMUNITY_MODERATOR,
    USER_ROLES.DISPUTE_RESOLVER,
    USER_ROLES.SUPER_ADMIN,
  ]),
  KYC_REVIEW: Object.freeze([USER_ROLES.KYC_REVIEWER, USER_ROLES.SUPER_ADMIN]),
  COMMUNITY_MODERATION: Object.freeze([
    USER_ROLES.COMMUNITY_MODERATOR,
    USER_ROLES.SUPER_ADMIN,
  ]),
  DISPUTE_RESOLUTION: Object.freeze([
    USER_ROLES.DISPUTE_RESOLVER,
    USER_ROLES.SUPER_ADMIN,
  ]),
  SUPER_ADMIN: Object.freeze([USER_ROLES.SUPER_ADMIN]),
});

const LEGACY_ROLE_CODES = Object.freeze({
  admin: USER_ROLES.SUPER_ADMIN,
  super_admin: USER_ROLES.SUPER_ADMIN,
  user: USER_ROLES.STANDARD_USER,
});

function normalizeRole(role) {
  const numericRole = Number(role);
  if (ROLE_VALUES.includes(numericRole)) return numericRole;

  const legacyRole = String(role || "")
    .trim()
    .toLowerCase();
  return LEGACY_ROLE_CODES[legacyRole] || USER_ROLES.STANDARD_USER;
}

function roleKeyForCode(roleCode) {
  return ROLE_KEYS_BY_CODE[normalizeRole(roleCode)] || ROLE_KEYS.STANDARD_USER;
}

function roleCodeForKey(roleKey) {
  return ROLE_CODES_BY_KEY[roleKey];
}

function rolePath(roleKey) {
  if (!roleCodeForKey(roleKey)) return "";
  return `roles.${roleKey}`;
}

function normalizeRoles(roles, legacyRole) {
  const normalizedRoles = {
    [ROLE_KEYS.STANDARD_USER]: USER_ROLES.STANDARD_USER,
  };

  if (roles && typeof roles === "object" && !Array.isArray(roles)) {
    Object.entries(roles).forEach(([roleKey, roleCode]) => {
      if (!roleCodeForKey(roleKey)) return;
      const normalizedCode = normalizeRole(roleCode);
      if (ROLE_CODES_BY_KEY[roleKey] === normalizedCode) {
        normalizedRoles[roleKey] = normalizedCode;
      }
    });
  }

  if (legacyRole !== undefined && legacyRole !== null) {
    const legacyCode = normalizeRole(legacyRole);
    normalizedRoles[roleKeyForCode(legacyCode)] = legacyCode;
  }

  return normalizedRoles;
}

function roleValuesFromRoles(roles, legacyRole) {
  return Object.values(normalizeRoles(roles, legacyRole));
}

function hasAnyRole(roles, allowedRoles, legacyRole) {
  return roleValuesFromRoles(roles, legacyRole).some((role) => allowedRoles.includes(role));
}

function roleLabel(role) {
  return ROLE_LABELS[normalizeRole(role)] || ROLE_LABELS[USER_ROLES.STANDARD_USER];
}

function roleLabels(roles, legacyRole) {
  return roleValuesFromRoles(roles, legacyRole).map(roleLabel);
}

module.exports = {
  ROLE_CODES_BY_KEY,
  ROLE_GROUPS,
  ROLE_KEYS,
  ROLE_LABELS,
  ROLE_VALUES,
  STAFF_ROLE_KEYS,
  USER_ROLES,
  hasAnyRole,
  normalizeRole,
  normalizeRoles,
  roleCodeForKey,
  roleKeyForCode,
  roleLabel,
  roleLabels,
  rolePath,
};
