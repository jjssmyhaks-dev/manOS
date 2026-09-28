import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { createMockModel } from './mock-model.js';

/**
 * Model access (PRD §6): OpenRouter in production with routed model IDs from
 * config, and a deterministic mock provider for dev/CI (AI_PROFILE=dev) that
 * requires no keys. Model IDs live in config, never hardcoded in prompts.
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
}

export function getModelConfig(): ModelConfig {
  const profile = (process.env.AI_PROFILE as AiProfile | undefined) ?? 'dev';
  return {
    profile,
    route: (process.env.AI_MODEL_ROUTE as keyof typeof PROD_ROUTES | undefined) ?? 'default',
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    openRouterBaseUrl: process.env.OPENROUTER_BASE_URL,
  };
}

export function getModelRoute(cfg = getModelConfig()): ModelRoute {
  return PROD_ROUTES[cfg.route] ?? PROD_ROUTES.default!;
}

/** Returns an AI SDK LanguageModel for the requested class. */
export function getModel(kind: 'fast' | 'reasoning' = 'reasoning', cfg = getModelConfig()): LanguageModel {
  const route = getModelRoute(cfg);
  if (cfg.profile === 'prod' && cfg.openRouterApiKey) {
    const openrouter = createOpenRouter({
      apiKey: cfg.openRouterApiKey,
      baseURL: cfg.openRouterBaseUrl,
    });
    return openrouter(kind === 'fast' ? route.fast : route.reasoning);
  }
  // dev: deterministic in-process mock — offline, free, stable for tests/CI.
  // Implements LanguageModelV2 directly and calls the same tools as a real model.
  return createMockModel();
}

export const MODEL_ID_ENV = 'OPENROUTER_API_KEY, AI_PROFILE=dev|prod, AI_MODEL_ROUTE=default|budget';
