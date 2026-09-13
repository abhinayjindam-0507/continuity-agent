export function createModelRouter({ registry, config }) {
  function getEligibleModels(requirements = {}) {
    const requiredCapabilities = Array.isArray(requirements.capabilities)
      ? requirements.capabilities
      : [];

    const models = registry.getAll();

    return models.filter(model => {
      if (model.health === 'unavailable') return false;

      if (
        requirements.privacyTier &&
        model.privacyTier !== requirements.privacyTier
      ) {
        return false;
      }

      if (
        Number.isInteger(requirements.minContextLimit) &&
        model.contextLimit < requirements.minContextLimit
      ) {
        return false;
      }

      if (
        requiredCapabilities.some(
          capability => !model.capabilities.includes(capability)
        )
      ) {
        return false;
      }

      if (
        requirements.requireAutomaticFallback &&
        model.automaticFallbackAllowed !== true
      ) {
        return false;
      }

      return true;
    });
  }

  function select(requirements = {}) {
    const eligible = getEligibleModels(requirements);

    const preferred = Array.isArray(config?.fallbackOrder)
      ? config.fallbackOrder
      : [];

    for (const modelId of preferred) {
      const match = eligible.find(model => model.modelId === modelId);
      if (match) return match;
    }

    return eligible[0] || null;
  }

  return {
    getEligibleModels,
    select
  };
}
