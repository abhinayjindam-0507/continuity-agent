export const PROVIDER_ERROR_TYPES = Object.freeze({
  transient: 'transient',
  unavailable: 'unavailable',
  invalid_request: 'invalid_request',
  authentication: 'authentication',
  quota: 'quota',
  billing: 'billing',
  policy: 'policy',
  unknown: 'unknown'
});

export class ProviderError extends Error {
  constructor(message, {
    type = PROVIDER_ERROR_TYPES.unknown,
    provider = '',
    status = null,
    retryable = false,
    cause = undefined
  } = {}) {
    super(message, { cause });

    this.name = 'ProviderError';
    this.type = type;
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}