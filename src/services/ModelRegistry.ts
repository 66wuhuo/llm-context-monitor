// ============================================================
// ModelRegistry — manages model metadata with user overrides
// ============================================================

import type { ModelConfig, Provider } from '../types';
import { BUILTIN_MODELS, DEFAULT_MODEL } from '../constants';

export class ModelRegistry {
  private models: Map<string, ModelConfig> = new Map();
  private overrides: Record<string, Partial<ModelConfig>> = {};

  constructor() {
    // Load built-in models
    for (const model of BUILTIN_MODELS) {
      this.models.set(model.id, { ...model });
    }
  }

  /** Apply user configuration overrides */
  applyOverrides(overrides: Record<string, Partial<ModelConfig>>): void {
    this.overrides = { ...overrides };
    for (const [id, partial] of Object.entries(overrides)) {
      const existing = this.models.get(id);
      if (existing) {
        this.models.set(id, { ...existing, ...partial });
      } else {
        // User defined a completely new model
        this.models.set(id, {
          id,
          name: id,
          provider: 'anthropic',
          contextWindow: 200_000,
          inputCostPer1M: 5.0,
          outputCostPer1M: 25.0,
          ...partial,
        });
      }
    }
  }

  /** Get model config by ID, with fuzzy fallback. Returns DEFAULT_MODEL only as last resort. */
  getModel(id: string): ModelConfig {
    // 1. Exact match (case-sensitive — Map keys are exact)
    const exact = this.models.get(id);
    if (exact) return exact;

    // 2. Case-insensitive exact match
    const lower = id.toLowerCase();
    for (const [key, config] of this.models) {
      if (key.toLowerCase() === lower) return config;
    }

    // 3. Fuzzy match via findModel (prefix → contains)
    const fuzzy = this.findModel(id);
    if (fuzzy) return fuzzy;

    // 4. Nothing matched — return a default entry keyed by the actual id
    return { ...DEFAULT_MODEL, id, name: `${id} (未识别)` };
  }

  /** Look up a model by partial ID match (fuzzy).
   *  Tries: exact → prefix (both directions) → contains → word boundary */
  findModel(partialId: string): ModelConfig | null {
    const lower = partialId.toLowerCase();

    // 1. Case-insensitive exact match
    for (const [id, config] of this.models) {
      if (id.toLowerCase() === lower) return config;
    }

    // 2a. Registered ID starts with requested ID
    //     e.g. request "claude-sonnet" matches registered "claude-sonnet-4-6"
    for (const [id, config] of this.models) {
      if (id.toLowerCase().startsWith(lower)) return config;
    }

    // 2b. Requested ID starts with registered ID (reverse direction)
    //     e.g. request "claude-sonnet-4-6-20250514" matches registered "claude-sonnet-4-6"
    for (const [id, config] of this.models) {
      if (lower.startsWith(id.toLowerCase())) return config;
    }

    // 3a. Registered ID contains requested ID
    for (const [id, config] of this.models) {
      if (id.toLowerCase().includes(lower)) return config;
    }

    // 3b. Requested ID contains registered ID (reverse direction)
    for (const [id, config] of this.models) {
      if (lower.includes(id.toLowerCase())) return config;
    }

    return null;
  }

  /** Get all registered models */
  getAllModels(): ModelConfig[] {
    return Array.from(this.models.values());
  }

  /** Get models by provider */
  getModelsByProvider(provider: Provider): ModelConfig[] {
    return this.getAllModels().filter((m) => m.provider === provider);
  }

  /** Check if a model is known */
  isKnown(id: string): boolean {
    return this.models.has(id);
  }

  /** Add or update a model at runtime */
  upsertModel(config: ModelConfig): void {
    this.models.set(config.id, { ...config });
  }
}
