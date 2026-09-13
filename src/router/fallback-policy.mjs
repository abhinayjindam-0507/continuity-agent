import { PROVIDER_ERROR_TYPES } from '../providers/provider-error.mjs';

export function shouldRetryProviderError(error) {
  if (!error) return false;

  if (error.retryable === true) return true;

  return error.type === PROVIDER_ERROR_TYPES.transient;
}

export function shouldFallbackProviderError(error) {
  if (!error) return false;

  return [
    PROVIDER_ERROR_TYPES.transient,
    PROVIDER_ERROR_TYPES.unavailable
  ].includes(error.type);
}

export function shouldPauseProviderError(error) {
  if (!error) return true;

  return ![
    PROVIDER_ERROR_TYPES.transient,
    PROVIDER_ERROR_TYPES.unavailable
  ].includes(error.type);
}