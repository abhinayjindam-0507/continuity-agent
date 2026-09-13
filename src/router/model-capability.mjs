export const MODEL_CAPABILITIES = [
  'text',
  'code',
  'tools',
  'vision',
  'browser',
  'long_context',
  'structured_output'
];

export const PRIVACY_TIERS = [
  'local_only',
  'cloud_approved',
  'restricted'
];

export const HEALTH_STATES = [
  'healthy',
  'degraded',
  'unavailable'
];

export const ROUTING_CLASSES = [
  'primary',
  'fallback',
  'support_only'
];

export function createModelCapability(input = {}) {
  if (!input.provider || typeof input.provider !== 'string') {
    throw new Error('Model provider is required.');
  }

  if (!input.modelId || typeof input.modelId !== 'string') {
    throw new Error('Model ID is required.');
  }

  const capabilities = Array.isArray(input.capabilities)
    ? [...new Set(input.capabilities.filter(item => MODEL_CAPABILITIES.includes(item)))]
    : [];

  return {
    provider: input.provider,
    modelId: input.modelId,
    version: typeof input.version === 'string' ? input.version : input.modelId,
    capabilities,
    contextLimit: Number.isInteger(input.contextLimit)
      ? Math.max(0, input.contextLimit)
      : 0,
    privacyTier: PRIVACY_TIERS.includes(input.privacyTier)
      ? input.privacyTier
      : 'local_only',
    health: HEALTH_STATES.includes(input.health)
      ? input.health
      : 'unavailable',
    routingClass: ROUTING_CLASSES.includes(input.routingClass)
      ? input.routingClass
      : 'support_only',
    automaticFallbackAllowed: input.automaticFallbackAllowed === true,
    lastCheckedAt:
      typeof input.lastCheckedAt === 'string'
        ? input.lastCheckedAt
        : new Date().toISOString()
  };
}
