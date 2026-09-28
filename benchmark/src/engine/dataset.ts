import { BenchmarkRecord } from '../adapters/types.js';

const FIRST_NAMES = [
  'Alex', 'Jordan', 'Taylor', 'Morgan', 'Sam', 'Chris', 'Pat', 'Casey', 'Riley', 'Avery',
  'Logan', 'Dakota', 'Reese', 'Quinn', 'Rowan', 'Cameron', 'Hayden', 'Finley', 'Skyler', 'Jesse'
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'
];

const CITIES = [
  'San Francisco', 'New York', 'London', 'Tokyo', 'Berlin', 'Paris', 'Singapore', 'Toronto',
  'Sydney', 'Amsterdam', 'Austin', 'Seattle', 'Dublin', 'Zurich', 'Stockholm', 'Seoul'
];

/**
 * Deterministic pseudo-random number generator (Mulberry32)
 */
function createPrng(seed: number) {
  let state = seed;
  return function () {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate N deterministic benchmark records
 */
export function generateBenchmarkDataset(count: number, seed: number = 42): BenchmarkRecord[] {
  const rand = createPrng(seed);
  const records: BenchmarkRecord[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const fnIndex = Math.floor(rand() * FIRST_NAMES.length);
    const lnIndex = Math.floor(rand() * LAST_NAMES.length);
    const cityIndex = Math.floor(rand() * CITIES.length);
    
    // Ages between 18 and 80
    const age = 18 + Math.floor(rand() * 63);
    // Score between 0.00 and 100.00 with 2 decimals
    const score = Math.round(rand() * 10000) / 100;
    // Active flag (approx 70% active)
    const active = rand() < 0.7 ? 1 : 0;

    records[i] = {
      id: i + 1,
      name: `${FIRST_NAMES[fnIndex]} ${LAST_NAMES[lnIndex]}`,
      age,
      score,
      city: CITIES[cityIndex],
      active,
    };
  }

  return records;
}

/**
 * Select M deterministic random IDs from 1..count for point lookups
 */
export function generateLookupIds(datasetSize: number, count: number = 100, seed: number = 999): number[] {
  const rand = createPrng(seed);
  const ids: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    ids[i] = Math.floor(rand() * datasetSize) + 1;
  }
  return ids;
}

/**
 * Generate deterministic orders dataset referencing user_ids 1..datasetSize
 */
export function generateOrdersDataset(datasetSize: number, seed: number = 777): import('../adapters/types.js').OrderRecord[] {
  const rand = createPrng(seed);
  const count = Math.min(1000, Math.max(100, Math.floor(datasetSize / 2)));
  const orders: import('../adapters/types.js').OrderRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    orders[i] = {
      id: 100000 + i + 1,
      user_id: Math.floor(rand() * datasetSize) + 1,
      amount: Math.round((10 + rand() * 490) * 100) / 100,
    };
  }
  return orders;
}
