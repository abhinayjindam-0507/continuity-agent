export async function ollamaChat(endpoint, model, messages, tools) {
  const response = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      options: { temperature: 0.15 }
    }),
    signal: AbortSignal.timeout(90_000)
  });

  if (!response.ok) {
    throw new Error(
      `Ollama returned ${response.status}: ${(await response.text()).slice(0, 400)}`
    );
  }

  return response.json();
}
