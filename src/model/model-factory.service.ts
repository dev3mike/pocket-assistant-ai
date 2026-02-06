/**
 * MODEL FACTORY – Centralized ChatOpenAI instantiation.
 * Provides cached model instances for different use cases (main, vision, coder, creative)
 * with consistent configuration. Supports structured output models for guaranteed JSON responses.
 *
 * Note: LLM observability is handled by TraceService with Langfuse integration.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { ConfigService } from '../config/config.service';

export type ModelType = 'main' | 'vision' | 'coder' | 'creative';

export interface ModelOptions {
  temperature?: number;
  tags?: string[];
  runName?: string;
}

@Injectable()
export class ModelFactoryService implements OnModuleInit {
  private readonly logger = new Logger(ModelFactoryService.name);
  private models: Map<string, ChatOpenAI> = new Map();
  private isInitialized = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    this.validateEnvironment();
    this.isInitialized = true;
    this.logger.log('ModelFactory initialized');
  }

  private validateEnvironment(): void {
    if (!process.env.OPENROUTER_API_KEY) {
      this.logger.warn('OPENROUTER_API_KEY not set - models will not work');
    }
  }

  private getBaseConfig() {
    return {
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
      },
    };
  }

  private getModelName(type: ModelType): string {
    const config = this.configService.getConfig();
    switch (type) {
      case 'main':
        return config.model;
      case 'vision':
        return config.vision_model;
      case 'coder':
        return config.coder_model;
      case 'creative':
        return config.model; // Same as main but with higher temperature
      default:
        return config.model;
    }
  }

  private getDefaultTemperature(type: ModelType): number {
    switch (type) {
      case 'main':
        return 0;
      case 'vision':
        return 0;
      case 'coder':
        return 0;
      case 'creative':
        return 0.7;
      default:
        return 0;
    }
  }

  private getCacheKey(type: ModelType, temperature: number): string {
    return `${type}:${temperature}`;
  }

  /**
   * Get a ChatOpenAI model instance for the specified type.
   * Models are cached and reused for efficiency.
   */
  getModel(type: ModelType, options?: ModelOptions): ChatOpenAI {
    const temperature = options?.temperature ?? this.getDefaultTemperature(type);
    const cacheKey = this.getCacheKey(type, temperature);

    // For tagged/named models, don't use cache to preserve metadata
    if (options?.tags || options?.runName) {
      return this.createModel(type, temperature, options);
    }

    if (this.models.has(cacheKey)) {
      return this.models.get(cacheKey)!;
    }

    const model = this.createModel(type, temperature);

    this.models.set(cacheKey, model);
    this.logger.debug(`Created ${type} model (temp=${temperature})`);

    return model;
  }

  /**
   * Create a model instance with optional metadata
   */
  private createModel(
    type: ModelType,
    temperature: number,
    options?: ModelOptions,
  ): ChatOpenAI {
    const modelConfig: any = {
      model: this.getModelName(type),
      temperature,
      ...this.getBaseConfig(),
    };

    // Add metadata for debugging (visible in logs, not sent to external services)
    if (options?.tags || options?.runName) {
      modelConfig.metadata = {
        modelType: type,
        tags: options?.tags,
        runName: options?.runName,
      };
    }

    return new ChatOpenAI(modelConfig);
  }

  /**
   * Get a model configured for structured output with a Zod schema.
   * This ensures the LLM returns valid JSON matching the schema.
   *
   * Note: Creates a new instance each time since withStructuredOutput
   * creates a new runnable. Consider caching if performance is an issue.
   */
  getStructuredModel<T extends z.ZodType>(
    type: ModelType,
    schema: T,
    options?: ModelOptions,
  ): ReturnType<ChatOpenAI['withStructuredOutput']> {
    const baseModel = this.getModel(type, options);
    return baseModel.withStructuredOutput(schema);
  }

  /**
   * Clear all cached models (useful for testing or config changes)
   */
  clearCache(): void {
    this.models.clear();
    this.logger.debug('Model cache cleared');
  }

  /**
   * Check if the factory is properly initialized
   */
  isReady(): boolean {
    return this.isInitialized && !!process.env.OPENROUTER_API_KEY;
  }

  /**
   * Get a fresh model instance (not cached) for special cases
   */
  createFreshModel(type: ModelType, options?: ModelOptions): ChatOpenAI {
    const temperature = options?.temperature ?? this.getDefaultTemperature(type);
    return this.createModel(type, temperature, options);
  }

  /**
   * Get the model name for a given type (useful for logging/tracing)
   */
  getModelNameForType(type: ModelType): string {
    return this.getModelName(type);
  }
}
