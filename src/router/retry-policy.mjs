export function canRetry(error, attempt, maxRetries) {
  if (!error || error.retryable !== true) {
    return false;
  }

  if (!Number.isInteger(attempt) || attempt < 0) {
    return false;
  }

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    return false;
  }

  return attempt < maxRetries;
}

export function nextRetryDelayMs(
  attempt,
  baseDelayMs = 100,
  maxDelayMs = 5_000
) {
  if (!Number.isInteger(attempt) || attempt < 0) {
    return baseDelayMs;
  }

  const safeBaseDelay = Math.max(0, baseDelayMs);
  const safeMaxDelay = Math.max(safeBaseDelay, maxDelayMs);

  return Math.min(
    safeBaseDelay * (2 ** attempt),
    safeMaxDelay
  );
}