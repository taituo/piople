import { createModels, createProvider, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * B1: Pi owns model transport. One "piople" provider in front of the
 * OpenAI-compatible gateway (same one Entropi uses). No fetch() in the loop.
 */
/** OpenAI-compatible gateway. Override with PIO_GATEWAY, e.g. https://opencode.ai/zen/go/v1 together with OPENCODE_API_KEY. */
export const gatewayUrl = (): string => process.env.PIO_GATEWAY ?? "http://10.91.1.1:8788/v1";

export type Gateway = { models: Models; providerId: string };

export function createGateway(baseUrl: string, bearer: string, modelIds: string[]): Gateway {
  const models = createModels();
  models.setProvider(createProvider({
    id: "piople",
    name: "Piople gateway",
    baseUrl,
    auth: { apiKey: { name: "gateway", resolve: async () => ({ auth: { apiKey: bearer } }) } },
    models: modelIds.map((id) => ({
      id,
      name: id,
      api: "openai-completions",
      provider: "piople",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16000,
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
    })),
    api: openAICompletionsApi(),
  }) as never);
  return { models, providerId: "piople" };
}

export function textOf(msg: { content?: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type: string }).type === "text")
      .map((b) => b.text).join("");
  }
  return "";
}
