/**
 * TRACE SERVICE - Provides request tracing with trace IDs, spans, and timing.
 * Integrates with Langfuse for LLM observability when configured.
 * Used for debugging and monitoring across the agent system.
 *
 * Langfuse setup:
 * - LANGFUSE_PUBLIC_KEY=your_public_key
 * - LANGFUSE_SECRET_KEY=your_secret_key
 * - LANGFUSE_HOST=https://cloud.langfuse.com (or self-hosted URL)
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Langfuse, LangfuseTraceClient, LangfuseSpanClient } from 'langfuse';

export interface Span {
  spanId: string;
  name: string;
  traceId: string;
  parentSpanId?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'running' | 'completed' | 'error';
  attributes: Record<string, any>;
  events: SpanEvent[];
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, any>;
}

export interface TraceContext {
  traceId: string;
  rootSpanId: string;
  chatId?: string;
}

interface LangfuseConfig {
  enabled: boolean;
  publicKey?: string;
  secretKey?: string;
  host?: string;
}

@Injectable()
export class TraceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TraceService.name);
  private readonly activeSpans: Map<string, Span> = new Map();
  private readonly completedTraces: Map<string, Span[]> = new Map();

  // Langfuse integration
  private langfuse: Langfuse | null = null;
  private langfuseConfig: LangfuseConfig = { enabled: false };
  private readonly langfuseTraces: Map<string, LangfuseTraceClient> = new Map();
  private readonly langfuseSpans: Map<string, LangfuseSpanClient> = new Map();

  async onModuleInit() {
    this.initializeLangfuse();
  }

  async onModuleDestroy() {
    if (this.langfuse) {
      await this.langfuse.shutdownAsync();
    }
  }

  /**
   * Initialize Langfuse client if configured
   */
  private initializeLangfuse(): void {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const host = process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';

    if (publicKey && secretKey) {
      try {
        this.langfuse = new Langfuse({
          publicKey,
          secretKey,
          baseUrl: host,
        });
        this.langfuseConfig = {
          enabled: true,
          publicKey,
          secretKey,
          host,
        };
        this.logger.log(`Langfuse tracing enabled (host: ${host})`);
        this.logger.log('All traces will be visible in your Langfuse dashboard');
      } catch (error) {
        this.logger.warn(`Failed to initialize Langfuse: ${error}`);
      }
    } else {
      this.logger.debug('Langfuse not configured. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to enable.');
    }
  }

  /**
   * Check if Langfuse tracing is enabled
   */
  isLangfuseEnabled(): boolean {
    return this.langfuseConfig.enabled;
  }

  /**
   * Get Langfuse client (for direct integration if needed)
   */
  getLangfuseClient(): Langfuse | null {
    return this.langfuse;
  }

  /**
   * Start a new trace (for a new request/message)
   * Creates a Langfuse trace if enabled.
   */
  startTrace(chatId?: string, metadata?: Record<string, any>): TraceContext {
    const traceId = randomUUID();

    // Create Langfuse trace if enabled
    if (this.langfuse) {
      try {
        const langfuseTrace = this.langfuse.trace({
          id: traceId,
          name: 'request',
          userId: chatId,
          metadata: {
            chatId,
            ...metadata,
          },
        });
        this.langfuseTraces.set(traceId, langfuseTrace);
      } catch (error) {
        this.logger.debug(`Failed to create Langfuse trace: ${error}`);
      }
    }

    const rootSpanId = this.startSpan('request', traceId, undefined, { chatId });

    return {
      traceId,
      rootSpanId,
      chatId,
    };
  }

  /**
   * Start a new span within a trace.
   * Creates a Langfuse span if tracing is enabled.
   */
  startSpan(
    name: string,
    traceId: string,
    parentSpanId?: string,
    attributes?: Record<string, any>,
  ): string {
    const spanId = randomUUID();
    const span: Span = {
      spanId,
      name,
      traceId,
      parentSpanId,
      startTime: Date.now(),
      status: 'running',
      attributes: attributes || {},
      events: [],
    };

    this.activeSpans.set(spanId, span);

    // Create Langfuse span if enabled
    const langfuseTrace = this.langfuseTraces.get(traceId);
    if (langfuseTrace) {
      try {
        const langfuseSpan = langfuseTrace.span({
          id: spanId,
          name,
          metadata: attributes,
        });
        this.langfuseSpans.set(spanId, langfuseSpan);
      } catch (error) {
        this.logger.debug(`Failed to create Langfuse span: ${error}`);
      }
    }

    this.logger.debug(`[${traceId.slice(0, 8)}] Started span: ${name}`);

    return spanId;
  }

  /**
   * Add an event to a span
   */
  addSpanEvent(spanId: string, name: string, attributes?: Record<string, any>): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.events.push({
        name,
        timestamp: Date.now(),
        attributes,
      });
    }
  }

  /**
   * Set span attributes
   */
  setSpanAttributes(spanId: string, attributes: Record<string, any>): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.attributes = { ...span.attributes, ...attributes };
    }
  }

  /**
   * End a span successfully.
   * Also ends the corresponding Langfuse span if enabled.
   */
  endSpan(spanId: string, attributes?: Record<string, any>): Span | undefined {
    const span = this.activeSpans.get(spanId);
    if (!span) return undefined;

    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = 'completed';
    if (attributes) {
      span.attributes = { ...span.attributes, ...attributes };
    }

    // End Langfuse span if exists
    const langfuseSpan = this.langfuseSpans.get(spanId);
    if (langfuseSpan) {
      try {
        langfuseSpan.end({
          metadata: span.attributes,
        });
        this.langfuseSpans.delete(spanId);
      } catch (error) {
        this.logger.debug(`Failed to end Langfuse span: ${error}`);
      }
    }

    this.activeSpans.delete(spanId);
    this.addToCompletedTrace(span);

    this.logger.debug(
      `[${span.traceId.slice(0, 8)}] Ended span: ${span.name} (${span.durationMs}ms)`,
    );

    return span;
  }

  /**
   * End a span with error.
   * Also ends the corresponding Langfuse span with error status if enabled.
   */
  endSpanWithError(spanId: string, error: string | Error): Span | undefined {
    const span = this.activeSpans.get(spanId);
    if (!span) return undefined;

    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = 'error';
    span.attributes.error = error instanceof Error ? error.message : error;

    // End Langfuse span with error if exists
    const langfuseSpan = this.langfuseSpans.get(spanId);
    if (langfuseSpan) {
      try {
        langfuseSpan.end({
          level: 'ERROR',
          statusMessage: span.attributes.error,
          metadata: span.attributes,
        });
        this.langfuseSpans.delete(spanId);
      } catch (err) {
        this.logger.debug(`Failed to end Langfuse span with error: ${err}`);
      }
    }

    this.activeSpans.delete(spanId);
    this.addToCompletedTrace(span);

    this.logger.debug(
      `[${span.traceId.slice(0, 8)}] Span error: ${span.name} - ${span.attributes.error}`,
    );

    return span;
  }

  /**
   * Get a trace summary for logging
   */
  getTraceSummary(traceId: string): {
    traceId: string;
    totalDurationMs: number;
    spanCount: number;
    spans: Array<{
      name: string;
      durationMs: number;
      status: string;
    }>;
  } | null {
    const spans = this.completedTraces.get(traceId);
    if (!spans || spans.length === 0) return null;

    // Find root span for total duration
    const rootSpan = spans.find((s) => !s.parentSpanId);
    const totalDurationMs = rootSpan?.durationMs || 0;

    return {
      traceId,
      totalDurationMs,
      spanCount: spans.length,
      spans: spans.map((s) => ({
        name: s.name,
        durationMs: s.durationMs || 0,
        status: s.status,
      })),
    };
  }

  /**
   * Get detailed trace data (for debugging)
   */
  getTraceDetails(traceId: string): Span[] | undefined {
    return this.completedTraces.get(traceId);
  }

  /**
   * Clean up old traces (call periodically)
   */
  cleanupOldTraces(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    const cutoff = now - maxAgeMs;

    for (const [traceId, spans] of this.completedTraces) {
      const rootSpan = spans.find((s) => !s.parentSpanId);
      if (rootSpan && rootSpan.endTime && rootSpan.endTime < cutoff) {
        this.completedTraces.delete(traceId);
      }
    }
  }

  private addToCompletedTrace(span: Span): void {
    const existing = this.completedTraces.get(span.traceId) || [];
    existing.push(span);
    this.completedTraces.set(span.traceId, existing);
  }

  /**
   * Record an LLM generation in Langfuse.
   * Use this for tracking LLM calls with input/output details.
   */
  recordGeneration(
    traceId: string,
    params: {
      name: string;
      model: string;
      input: any;
      output?: any;
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
      metadata?: Record<string, any>;
    },
  ): void {
    const langfuseTrace = this.langfuseTraces.get(traceId);
    if (!langfuseTrace) return;

    try {
      langfuseTrace.generation({
        name: params.name,
        model: params.model,
        input: params.input,
        output: params.output,
        usage: params.usage,
        metadata: params.metadata,
      });
    } catch (error) {
      this.logger.debug(`Failed to record Langfuse generation: ${error}`);
    }
  }

  /**
   * End a trace (flush to Langfuse).
   * Call this when the request is complete.
   */
  endTrace(traceId: string): void {
    // Remove from local storage
    this.langfuseTraces.delete(traceId);

    // Langfuse auto-flushes, but we can trigger a flush for this trace
    if (this.langfuse) {
      this.langfuse.flushAsync().catch((error) => {
        this.logger.debug(`Failed to flush Langfuse: ${error}`);
      });
    }
  }

  /**
   * Score a trace in Langfuse (for feedback/evaluation)
   */
  scoreTrace(
    traceId: string,
    params: {
      name: string;
      value: number;
      comment?: string;
    },
  ): void {
    if (!this.langfuse) return;

    try {
      this.langfuse.score({
        traceId,
        name: params.name,
        value: params.value,
        comment: params.comment,
      });
    } catch (error) {
      this.logger.debug(`Failed to score Langfuse trace: ${error}`);
    }
  }
}
