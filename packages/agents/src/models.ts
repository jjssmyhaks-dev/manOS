import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { createMockModel } from './mock-model.js';

/**
 * Model access (PRD §6): OpenRouter in production with routed model IDs from
 * config, and a deterministic mock provider for dev/CI (AI_PROFILE=dev) that
 * requires no keys. Model IDs live in config, never hardcoded in prompts.
 *
 * PLATFORM-SIDE KEYS: the OpenRouter key belongs to the product company, not
 * the subscriber. Tenants never paste a key — they only pick a model class
 * (route) in Settings. Config precedence (server paths use resolveModelConfig):
 *   1. env OPENROUTER_API_KEY (platform key) + the org's chosen ai_config.model_route
 *   2. legacy: an org-specific api_key in ai_config (kept working for old rows)
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

/** Subscriber-facing labels for the model picker (Settings). */
export const ROUTE_LABELS: Record<string, { title: string; models: string; blurb: string }> = {
  default: {
    title: 'Smartest',
    models: 'GPT-4o class',
    blurb: 'Best explanations, complex documents, trickier Hinglish queries.',
  },
  budget: {
    title: 'Value',
    models: 'Flash / Sonnet class',
    blurb: 'Everyday questions at a lower cost — slightly shorter answers.',
  },
};

/** Rough blended cost per 1k tokens (INR) for usage estimates on the bill. */
const ROUTE_INR_PER_1K: Record<string, { reasoning: number; fast: number }> = {
  default: { reasoning: 0.55, fast: 0.001 },
  budget: { reasoning: 8.0, fast: 0.002 },
};

export function estimateCostInr(route: string, kind: 'fast' | 'reasoning', tokens: number): number {
  const rates = ROUTE_INR_PER_1K[route] ?? ROUTE_INR_PER_1K.default!;
  return (tokens / 1000) * (kind === 'fast' ? rates.fast : rates.reasoning);
}

/** True when the platform's own OpenRouter key is configured. */
export function platformHasAiKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

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
 * Async resolution for server paths. Platform-first: the company's env key
 * drives production; the org only chooses the route (model class). A legacy
 * per-org api_key still wins for old rows so nothing breaks.
 */
export async function resolveModelConfig(
  orgId: string | undefined,
  lookup?: AiConfigLookup,
  fallbackEnv: ModelConfig = envConfig()
): Promise<ModelConfig> {
  const row = orgId && lookup ? await lookup.get(orgId) : undefined;
  const orgRoute = (row?.model_route as keyof typeof PROD_ROUTES | null) ?? null;

  // 1. platform key (company-side): all tenants ride on it
  if (fallbackEnv.openRouterApiKey) {
    return {
      ...fallbackEnv,
      profile: 'prod',
      route: orgRoute ?? fallbackEnv.route,
      source: 'env',
    };
  }

  // 2. legacy per-org key (deprecated; rows created before platform keys)
  if (row?.api_key) {
    return {
      profile: 'prod',
      route: orgRoute ?? fallbackEnv.route,
      openRouterApiKey: row.api_key,
      openRouterBaseUrl: fallbackEnv.openRouterBaseUrl,
      source: 'org',
    };
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

export const MODEL_ID_ENV = 'OPENROUTER_API_KEY (platform-side), AI_PROFILE=dev|prod, AI_MODEL_ROUTE=default|budget';
