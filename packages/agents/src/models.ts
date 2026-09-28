import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { createMockModel } from './mock-model.js';

/**
 * Model access (PRD §6): OpenRouter in production with routed model IDs from
 * config, and a deterministic mock provider for dev/CI (AI_PROFILE=dev) that
 * requires no keys. Model IDs live in config, never hardcoded in prompts.
 *
 * Config precedence (server paths use resolveModelConfig):
 *   1. org row in ai_config (set from Settings UI — key stored server-side only)
 *   2. env: OPENROUTER_API_KEY + AI_PROFILE/AI_MODEL_ROUTE
 *   3. dev fallback: in-process mock model
 */

export type AiProfile = 'dev' | 'prod';

export interface ModelRoute {
  /** cheap/fast for extraction + classification */
  fast: string;
  /** stronger for reasoning/planning */
  reasoning: string;
}

const PROD_ROUTES: Record<string, ModelRoute> = {
  default: { fast: 'openai/gpt-4o-mini', reasoning: 'openai/gpt-4o' },
  budget: { fast: 'google/gemini-2.0-flash-001', reasoning: 'anthropic/claude-3.7-sonnet' },
};

export interface ModelConfig {
  profile: AiProfile;
  route: keyof typeof PROD_ROUTES;
  openRouterApiKey?: string;
  openRouterBaseUrl?: string;
  /** where the effective config came from */
  source: 'org' | 'env' | 'dev';
}

/** Org-level AI config row (models.ts stays dependency-light: raw SQL shape). */
export interface AiConfigLookup {
  get(orgId: string): Promise<{ api_key: string | null; model_route: string | null } | undefined>;
}

function envConfig(): ModelConfig {
  const profile = (process.env.AI_PROFILE as AiProfile | undefined) ?? 'dev';
  return {
    profile,
    route: (process.env.AI_MODEL_ROUTE as keyof typeof PROD_ROUTES | undefined) ?? 'default',
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    openRouterBaseUrl: process.env.OPENROUTER_BASE_URL,
    source: 'env',
  };
}

export function getModelConfig(): ModelConfig {
  return envConfig();
}

/**
 * Async resolution for server paths: checks the org's ai_config row first
 * (Settings UI), then env. An org key implies prod behaviour for that org.
 */
export async function resolveModelConfig(
  orgId: string | undefined,
  lookup?: AiConfigLookup,
  fallbackEnv: ModelConfig = envConfig()
): Promise<ModelConfig> {
  if (orgId && lookup) {
    const row = await lookup.get(orgId);
    if (row?.api_key) {
      return {
        profile: 'prod',
        route: (row.model_route as keyof typeof PROD_ROUTES | null) ?? fallbackEnv.route,
        openRouterApiKey: row.api_key,
        openRouterBaseUrl: fallbackEnv.openRouterBaseUrl,
        source: 'org',
      };
    }
  }
  return fallbackEnv;
}

export function getModelRoute(cfg = getModelConfig()): ModelRoute {
  return PROD_ROUTES[cfg.route] ?? PROD_ROUTES.default!;
}

/** Sync model getter (tests / sync contexts — env config only). */
export function getModel(kind: 'fast' | 'reasoning' = 'reasoning', cfg = getModelConfig()): LanguageModel {
  if (cfg.profile === 'prod' && cfg.openRouterApiKey) {
    return openRouterModel(kind, cfg);
  }
  // dev: deterministic in-process mock — offline, free, stable for tests/CI.
  // Implements LanguageModelV2 directly and calls the same tools as a real model.
  return createMockModel();
}

function openRouterModel(kind: 'fast' | 'reasoning', cfg: ModelConfig): LanguageModel {
  const route = getModelRoute(cfg);
  const openrouter = createOpenRouter({
    apiKey: cfg.openRouterApiKey,
    baseURL: cfg.openRouterBaseUrl,
  });
  return openrouter(kind === 'fast' ? route.fast : route.reasoning);
}

/**
 * Async model getter for server paths (orchestrator/extraction/digest):
 * resolves org-level config (Settings-managed OpenRouter key) before env.
 */
export async function getModelForOrg(
  orgId: string,
  kind: 'fast' | 'reasoning',
  lookup?: AiConfigLookup
): Promise<{ model: LanguageModel; cfg: ModelConfig }> {
  const cfg = await resolveModelConfig(orgId, lookup);
  if (cfg.profile === 'prod' && cfg.openRouterApiKey) {
    return { model: openRouterModel(kind, cfg), cfg };
  }
  return { model: getModel(kind, cfg), cfg };
}

export const MODEL_ID_ENV = 'OPENROUTER_API_KEY, AI_PROFILE=dev|prod, AI_MODEL_ROUTE=default|budget';
