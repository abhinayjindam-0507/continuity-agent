import {
  ProviderError,
  PROVIDER_ERROR_TYPES
} from './provider-error.mjs';

function classifyStatus(status) {
  if (status === 408 || status === 429 || status >= 500) {
    return {
      type:
        status === 429
          ? PROVIDER_ERROR_TYPES.quota
          : PROVIDER_ERROR_TYPES.transient,
      retryable: status !== 429
    };
  }

  if (status === 401 || status === 403) {
    return {
      type: PROVIDER_ERROR_TYPES.authentication,
      retryable: false
    };
  }

  if (status === 404) {
    return {
      type: PROVIDER_ERROR_TYPES.unavailable,
      retryable: false
    };
  }

  if (status >= 400 && status < 500) {
    return {
      type: PROVIDER_ERROR_TYPES.invalid_request,
      retryable: false
    };
  }

  return {
    type: PROVIDER_ERROR_TYPES.unknown,
    retryable: false
  };
}

export async function ollamaChat(endpoint, model, messages, tools, options = {}) {
  let response;

  try {
    const signals = [AbortSignal.timeout(90_000)];
    if (options?.signal) {
      signals.push(options.signal);
    }
    const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    response = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
        options: { temperature: 0.15 }
      }),
      signal: combinedSignal
    });
  } catch (error) {
    if (options?.signal?.aborted || error.name === 'AbortError') {
      const abortErr = new Error('Ollama request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw new ProviderError(
      `Ollama request failed: ${error.message}`,
      {
        type: PROVIDER_ERROR_TYPES.transient,
        provider: 'ollama',
        retryable: true,
        cause: error
      }
    );
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    const classification = classifyStatus(response.status);

    throw new ProviderError(
      `Ollama returned ${response.status}: ${detail}`,
      {
        type: classification.type,
        provider: 'ollama',
        status: response.status,
        retryable: classification.retryable
      }
    );
  }

  return response.json();
}