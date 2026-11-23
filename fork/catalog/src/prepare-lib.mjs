export function parseNonNegativeInteger(value, fallback, name) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be an integer >= 0`);
  }
  return parsed;
}

export function resolveDiscoveryPlatforms({ available, existing, setting = 'existing' }) {
  const normalized = setting.trim().toLowerCase();
  const sortedAvailable = [...available].sort();
  if (normalized === 'none') return [];
  if (normalized === 'all') return sortedAvailable;
  if (normalized === 'existing' || normalized === '') {
    return sortedAvailable.filter((platform) => existing.has(platform));
  }
  return setting
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean)
    .filter((platform, index, values) => values.indexOf(platform) === index);
}

/**
 * Whether a provider error is strong evidence that the model identity itself
 * is dead, rather than a transient quota, transport or overload failure.
 * Only auto-discovered rows are ever disabled from this signal.
 */
export function isPermanentModelRejection(message) {
  if (typeof message !== 'string' || message.trim() === '') return false;
  const text = message.toLowerCase();
  const transient = /429|rate[ -]?limit|quota|temporar|overload|timeout|timed out|fetch failed|econn|enotfound|eai_again|tls|certificate|5\d\d|502|503|504/.test(text);
  if (transient) return false;
  return /404|not found|unknown model|model[^\n]*(?:does not exist|not exist|not available|unsupported)|unsupported model|403|forbidden|permission denied|no such model/.test(text);
}
