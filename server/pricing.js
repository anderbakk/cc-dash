// USD per million tokens (Anthropic first-party API list prices, Oct 2026).
// Cache writes default to 1.25x (5 min) / 2x (1 h) input and cache reads to
// 0.1x input, unless a model overrides `cacheRead`.
// On a subscription plan this is what the usage *would* cost on the API.
const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4': { input: 1, output: 5 },
};

// Longest prefix first so 'claude-opus-5-5' wins over 'claude-opus-5'.
const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

export function priceFor(model) {
  if (!model) return null;
  const key = KEYS.find((k) => model.startsWith(k));
  if (!key) return null;
  const p = PRICES[key];
  return {
    input: p.input,
    output: p.output,
    cacheWrite5m: p.input * 1.25,
    cacheWrite1h: p.input * 2,
    cacheRead: p.cacheRead ?? p.input * 0.1,
  };
}

// usage: accumulated token counts for one model, see transcripts.js
export function costFor(model, u) {
  const p = priceFor(model);
  if (!p) return null;
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheWrite5m * p.cacheWrite5m +
      u.cacheWrite1h * p.cacheWrite1h +
      u.cacheRead * p.cacheRead) /
    1e6
  );
}
