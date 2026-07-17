const crypto = require("crypto");
const { EXPLORE_FEED } = require("../constants/recommendations");
const httpError = require("./httpError");
const { createSeededRandom, shuffled } = require("./recommendationFeed");

const TYPES = ["item", "finspo", "event", "user"];
const CURSOR_SECRET =
  process.env.EXPLORE_CURSOR_SECRET ||
  process.env.JWT_ACCESS_SECRET ||
  "foose-local-explore-cursor";

const entryKey = (entry) => `${entry.type}:${String(entry.id || entry._id || "")}`;
const sign = (payload) =>
  crypto.createHmac("sha256", CURSOR_SECRET).update(payload).digest("base64url");

const encodeExploreCursor = (value) => {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...value })).toString("base64url");
  return `${payload}.${sign(payload)}`;
};

const decodeExploreCursor = (cursor) => {
  try {
    const [payload, signature, extra] = String(cursor || "").split(".");
    if (!payload || !signature || extra) throw new Error("invalid");
    const expected = Buffer.from(sign(payload), "utf8");
    const supplied = Buffer.from(signature, "utf8");
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      throw new Error("invalid");
    }
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const snapshot = new Date(value.snapshot);
    const personalizedKeys = value.personalizedKeys === undefined ? [] : value.personalizedKeys;
    const validPersonalizedKeys =
      Array.isArray(personalizedKeys) &&
      personalizedKeys.length <= EXPLORE_FEED.MAX_PERSONALIZED &&
      new Set(personalizedKeys).size === personalizedKeys.length &&
      personalizedKeys.every((key) => {
        const [type, id, extraPart] = String(key || "").split(":");
        return TYPES.includes(type) && Boolean(id) && !extraPart && String(key).length <= 160;
      });
    if (
      value.v !== 1 ||
      !String(value.audience || "") ||
      !String(value.seed || "") ||
      !validPersonalizedKeys ||
      Number.isNaN(snapshot.valueOf()) ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      value.offset > EXPLORE_FEED.MAX_CURSOR_OFFSET
    ) throw new Error("invalid");
    return {
      audience: String(value.audience),
      lastType: TYPES.includes(value.lastType) ? value.lastType : "",
      offset: value.offset,
      personalizedKeys: personalizedKeys.map(String),
      run: Number.isSafeInteger(value.run) && value.run >= 0 ? value.run : 0,
      seed: String(value.seed),
      snapshot,
    };
  } catch {
    throw httpError(400, "Explore cursor is invalid or expired");
  }
};

const quotasForSize = (size, quotas = EXPLORE_FEED.QUOTAS) => {
  const target = Math.max(Math.floor(Number(size) || 0), 0);
  const totalWeight = TYPES.reduce((sum, type) => sum + Number(quotas[type] || 0), 0) || 1;
  const rows = TYPES.map((type, index) => {
    const exact = target * Number(quotas[type] || 0) / totalWeight;
    return { type, index, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remainder = target - rows.reduce((sum, row) => sum + row.count, 0);
  [...rows]
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    .forEach((row) => {
      if (remainder <= 0) return;
      rows[row.index].count += 1;
      remainder -= 1;
    });
  return Object.fromEntries(rows.map(({ type, count }) => [type, count]));
};

const orderExploreBatch = (entries, seed, initialState = {}) => {
  const random = createSeededRandom(seed);
  const prepared = entries.map((entry) => ({ entry, tie: random() }))
    .sort((left, right) =>
      Number(right.entry.personalized) - Number(left.entry.personalized) ||
      (left.entry.personalized
        ? Number(left.entry.personalizedRank ?? Number.MAX_SAFE_INTEGER) -
          Number(right.entry.personalizedRank ?? Number.MAX_SAFE_INTEGER)
        : 0) ||
      left.tie - right.tie ||
      entryKey(left.entry).localeCompare(entryKey(right.entry)));
  const ordered = [];
  let lastType = TYPES.includes(initialState.lastType) ? initialState.lastType : "";
  let run = Math.max(Number(initialState.run) || 0, 0);

  while (prepared.length) {
    let selectedIndex = 0;
    if (lastType && run >= 2) {
      const alternate = prepared.findIndex(({ entry }) => entry.type !== lastType);
      if (alternate >= 0) selectedIndex = alternate;
    }
    const [{ entry }] = prepared.splice(selectedIndex, 1);
    ordered.push(entry);
    if (entry.type === lastType) run += 1;
    else {
      lastType = entry.type;
      run = 1;
    }
  }
  return ordered;
};

const trailingDiversityState = (entries, initialState = {}) => {
  let lastType = TYPES.includes(initialState.lastType) ? initialState.lastType : "";
  let run = Math.max(Number(initialState.run) || 0, 0);
  entries.forEach((entry) => {
    if (entry.type === lastType) run += 1;
    else {
      lastType = entry.type;
      run = 1;
    }
  });
  return { lastType, run };
};

const selectExplorePersonalizedKeys = ({ candidates, seed, size = EXPLORE_FEED.PAGE_SIZE }) => {
  const unique = new Map();
  candidates.forEach((entry) => {
    const key = entryKey(entry);
    if (key && TYPES.includes(entry.type) && !unique.has(key)) unique.set(key, entry);
  });
  const pool = [...unique.values()];
  const targetSize = Math.min(Math.max(Number(size) || 0, 0), pool.length);
  const quotas = quotasForSize(targetSize);
  const availability = Object.fromEntries(TYPES.map((type) => [
    type,
    pool.filter((entry) => entry.type === type).length,
  ]));
  const shortageSlots = Math.max(
    targetSize - TYPES.reduce(
      (total, type) => total + Math.min(availability[type], quotas[type]),
      0,
    ),
    0,
  );
  const tieRandom = createSeededRandom(`${seed}:personalized`);
  const scored = pool.map((entry) => ({ entry, tie: tieRandom() }))
    .filter(({ entry }) => Number(entry.score || 0) > 0)
    .sort((left, right) =>
      Number(right.entry.score || 0) - Number(left.entry.score || 0) ||
      left.tie - right.tie ||
      entryKey(left.entry).localeCompare(entryKey(right.entry)));
  const selected = [];
  const seen = new Set();
  const counts = Object.fromEntries(TYPES.map((type) => [type, 0]));

  for (const { entry } of scored) {
    if (selected.length >= Math.min(EXPLORE_FEED.MAX_PERSONALIZED, targetSize)) break;
    if (counts[entry.type] >= quotas[entry.type]) continue;
    const key = entryKey(entry);
    selected.push(key);
    seen.add(key);
    counts[entry.type] += 1;
  }

  let overflow = 0;
  for (const { entry } of scored) {
    if (
      selected.length >= Math.min(EXPLORE_FEED.MAX_PERSONALIZED, targetSize) ||
      overflow >= shortageSlots
    ) break;
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    selected.push(key);
    seen.add(key);
    overflow += 1;
  }
  return selected;
};

const selectExploreBatch = ({
  candidates,
  initialState,
  personalized,
  personalizedKeys,
  seed,
  size,
}) => {
  const targetSize = Math.min(Math.max(Number(size) || 0, 0), candidates.length);
  const quotas = quotasForSize(targetSize);
  const seen = new Set();
  const selected = [];
  const counts = Object.fromEntries(TYPES.map((type) => [type, 0]));
  let personalizedCount = 0;
  const fixedKeys = Array.isArray(personalizedKeys)
    ? personalizedKeys
    : personalized
      ? selectExplorePersonalizedKeys({ candidates, seed, size: targetSize })
      : [];
  const candidatesByKey = new Map(candidates.map((entry) => [entryKey(entry), entry]));

  for (const [personalizedRank, key] of fixedKeys.entries()) {
    if (selected.length >= targetSize) break;
    const entry = candidatesByKey.get(key);
    if (!entry || seen.has(key)) continue;
    seen.add(key);
    counts[entry.type] += 1;
    personalizedCount += 1;
    selected.push({ ...entry, personalized: true, personalizedRank });
  }

  TYPES.forEach((type) => {
    const pool = shuffled(
      candidates.filter((entry) => entry.type === type),
      createSeededRandom(`${seed}:discovery:${type}`),
    );
    for (const entry of pool) {
      if (selected.length >= targetSize) break;
      if (counts[type] >= quotas[type]) break;
      const key = entryKey(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      counts[type] += 1;
      selected.push({ ...entry, personalized: false });
    }
  });

  if (selected.length < targetSize) {
    const fallback = shuffled(candidates, createSeededRandom(`${seed}:shortage-fill`));
    for (const entry of fallback) {
      if (selected.length >= targetSize) break;
      const key = entryKey(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      counts[entry.type] += 1;
      selected.push({ ...entry, personalized: false });
    }
  }

  const results = orderExploreBatch(selected, `${seed}:order`, initialState);
  return {
    allocations: counts,
    discoveryCount: results.length - personalizedCount,
    personalizedCount,
    quotas,
    results,
  };
};

const composeExploreFeed = ({ candidates, personalized, personalizedKeys, seed }) => {
  const unique = new Map();
  candidates.forEach((entry) => {
    const key = entryKey(entry);
    if (key && !unique.has(key) && TYPES.includes(entry.type)) unique.set(key, entry);
  });
  const remaining = [...unique.values()];
  const results = [];
  const batches = [];
  let batchIndex = 0;
  let diversityState = { lastType: "", run: 0 };
  const fixedPersonalizedKeys = Array.isArray(personalizedKeys)
    ? personalizedKeys
    : personalized
      ? selectExplorePersonalizedKeys({ candidates: remaining, seed })
      : [];

  while (remaining.length) {
    const batch = selectExploreBatch({
      candidates: remaining,
      initialState: diversityState,
      personalizedKeys: fixedPersonalizedKeys,
      seed: `${seed}:batch:${batchIndex}`,
      size: Math.min(EXPLORE_FEED.PAGE_SIZE, remaining.length),
    });
    if (!batch.results.length) break;
    diversityState = trailingDiversityState(batch.results, diversityState);
    const selected = new Set(batch.results.map(entryKey));
    results.push(...batch.results);
    batches.push({
      allocations: batch.allocations,
      discoveryCount: batch.discoveryCount,
      personalizedCount: batch.personalizedCount,
      quotas: batch.quotas,
    });
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (selected.has(entryKey(remaining[index]))) remaining.splice(index, 1);
    }
    batchIndex += 1;
  }
  return { batches, results };
};

module.exports = {
  TYPES,
  composeExploreFeed,
  decodeExploreCursor,
  encodeExploreCursor,
  orderExploreBatch,
  quotasForSize,
  selectExploreBatch,
  selectExplorePersonalizedKeys,
  trailingDiversityState,
};
