const stringSeed = (value) => {
  let hash = 2166136261;
  const text = String(value || "");

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
};

const createSeededRandom = (value) => {
  let seed = stringSeed(value);

  return () => {
    seed += 0x6d2b79f5;
    let result = seed;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffled = (items, random) => {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(random() * (index + 1));
    [result[index], result[nextIndex]] = [result[nextIndex], result[index]];
  }

  return result;
};

const itemId = (item) => String(item?._id || item?.id || "");

const takeUnique = (items, limit, seen) => {
  const selected = [];

  for (const item of items) {
    const id = itemId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    selected.push(item);
    if (selected.length >= limit) break;
  }

  return selected;
};

const promotedSlots = (total, count, requestedGap, random) => {
  if (!total || !count) return { actualGap: 0, slots: [] };
  if (count === 1) {
    return {
      actualGap: total,
      slots: [Math.floor(random() * total)],
    };
  }

  const feasibleGap = Math.floor((total - 1) / (count - 1));
  const actualGap = Math.max(1, Math.min(requestedGap, feasibleGap));
  const slack = Math.max(total - 1 - actualGap * (count - 1), 0);
  const extras = Array.from({ length: count + 1 }, () => 0);

  for (let index = 0; index < slack; index += 1) {
    extras[Math.floor(random() * extras.length)] += 1;
  }

  const slots = [extras[0]];
  for (let index = 1; index < count; index += 1) {
    slots.push(slots[index - 1] + actualGap + extras[index]);
  }

  return { actualGap, slots };
};

const composeFirstPage = ({
  fillers,
  newItems,
  pageSize,
  promoted,
  promotedCount,
  requestedGap,
  seed,
  suggested,
  suggestedCount,
  newCount,
}) => {
  const random = createSeededRandom(seed);
  const seen = new Set();
  const selectedSuggested = takeUnique(suggested, suggestedCount, seen);
  const selectedPromoted = takeUnique(promoted, promotedCount, seen);
  const selectedNew = takeUnique(newItems, newCount, seen);
  const nonPromoted = [...selectedSuggested, ...selectedNew];
  const remainingCapacity = Math.max(pageSize - selectedPromoted.length - nonPromoted.length, 0);
  nonPromoted.push(...takeUnique(fillers, remainingCapacity, seen));

  const targetSize = Math.min(pageSize, nonPromoted.length + selectedPromoted.length);
  const trimmedNonPromoted = shuffled(nonPromoted, random).slice(0, targetSize - selectedPromoted.length);
  const { actualGap, slots } = promotedSlots(
    targetSize,
    selectedPromoted.length,
    requestedGap,
    random,
  );
  const promotedBySlot = new Map(slots.map((slot, index) => [slot, selectedPromoted[index]]));
  const results = [];
  let regularIndex = 0;

  for (let index = 0; index < targetSize; index += 1) {
    const promotedItem = promotedBySlot.get(index);
    results.push(promotedItem || trimmedNonPromoted[regularIndex]);
    if (!promotedItem) regularIndex += 1;
  }

  return {
    actualGap,
    allocations: {
      new: selectedNew.length,
      promoted: selectedPromoted.length,
      suggested: selectedSuggested.length,
    },
    requestedGap,
    results: results.filter(Boolean),
  };
};

const composePersonalizedFeed = ({ promoted, regular, requestedGap, seed }) => {
  const random = createSeededRandom(seed);
  const seen = new Set();
  const uniqueRegular = takeUnique(regular, regular.length, seen);
  const uniquePromoted = takeUnique(promoted, promoted.length, seen);
  const gap = Math.max(Number(requestedGap) || 1, 1);
  const maximumPromoted = Math.max(
    Math.floor((uniqueRegular.length + gap - 1) / Math.max(gap - 1, 1)),
    uniqueRegular.length ? 0 : 1,
  );
  const selectedPromoted = shuffled(uniquePromoted, random).slice(0, maximumPromoted);
  const targetSize = uniqueRegular.length + selectedPromoted.length;
  const { actualGap, slots } = promotedSlots(
    targetSize,
    selectedPromoted.length,
    gap,
    random,
  );
  const promotedBySlot = new Map(slots.map((slot, index) => [slot, selectedPromoted[index]]));
  const results = [];
  let regularIndex = 0;

  for (let index = 0; index < targetSize; index += 1) {
    const promotedItem = promotedBySlot.get(index);
    results.push(promotedItem || uniqueRegular[regularIndex]);
    if (!promotedItem) regularIndex += 1;
  }

  return {
    actualGap,
    excludedPromoted: uniquePromoted.length - selectedPromoted.length,
    promotedCount: selectedPromoted.length,
    requestedGap: gap,
    results: results.filter(Boolean),
  };
};

const selectSuggestedCandidates = ({ minimumScore, scoredCandidates, seed }) => {
  const personalized = scoredCandidates
    .filter(({ score }) => score >= minimumScore)
    .sort((left, right) => right.score - left.score || left.tie - right.tie);

  if (personalized.length) {
    return {
      personalized: true,
      results: personalized.map(({ listing }) => listing),
    };
  }

  return {
    personalized: false,
    results: shuffled(
      scoredCandidates,
      createSeededRandom(`${seed}:fallback`),
    ).map(({ listing }) => listing),
  };
};

module.exports = {
  composeFirstPage,
  composePersonalizedFeed,
  createSeededRandom,
  promotedSlots,
  selectSuggestedCandidates,
  shuffled,
};
