/**
 * EMBEDDING SERVICE - Generates text embeddings via OpenRouter.
 * Used for semantic search in the memory system.
 * Embeddings are cached to avoid redundant API calls.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OpenAIEmbeddings } from '@langchain/openai';
import * as crypto from 'crypto';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private embeddings: OpenAIEmbeddings | null = null;

  // In-memory cache to avoid redundant embeddings within a session
  private cache: Map<string, number[]> = new Map();

  constructor() {
    this.initializeEmbeddings();
  }

  private initializeEmbeddings(): void {
    try {
      if (!process.env.OPENROUTER_API_KEY) {
        this.logger.warn('OPENROUTER_API_KEY not set - embeddings will not work');
        return;
      }

      this.embeddings = new OpenAIEmbeddings({
        model: 'openai/text-embedding-3-small',
        configuration: {
          baseURL: 'https://openrouter.ai/api/v1',
        },
        apiKey: process.env.OPENROUTER_API_KEY,
      });

      this.logger.log('EmbeddingService initialized with OpenRouter');
    } catch (error) {
      this.logger.error(`Failed to initialize embeddings: ${error}`);
    }
  }

  /**
   * Generate a hash for text to use as cache key
   */
  private hashText(text: string): string {
    return crypto.createHash('md5').update(text).digest('hex');
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.embeddings) {
      throw new Error('EmbeddingService not initialized - check OPENROUTER_API_KEY');
    }

    const hash = this.hashText(text);

    // Check cache
    if (this.cache.has(hash)) {
      return this.cache.get(hash)!;
    }

    try {
      const embedding = await this.embeddings.embedQuery(text);
      this.cache.set(hash, embedding);
      return embedding;
    } catch (error) {
      this.logger.error(`Failed to generate embedding: ${error}`);
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts (batched)
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.embeddings) {
      throw new Error('EmbeddingService not initialized - check OPENROUTER_API_KEY');
    }

    if (texts.length === 0) {
      return [];
    }

    // Check which texts need embeddings
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const textsToEmbed: { index: number; text: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
      const hash = this.hashText(texts[i]);
      if (this.cache.has(hash)) {
        results[i] = this.cache.get(hash)!;
      } else {
        textsToEmbed.push({ index: i, text: texts[i] });
      }
    }

    // Generate embeddings for texts not in cache
    if (textsToEmbed.length > 0) {
      try {
        const embeddings = await this.embeddings.embedDocuments(
          textsToEmbed.map((t) => t.text),
        );

        for (let i = 0; i < textsToEmbed.length; i++) {
          const { index, text } = textsToEmbed[i];
          const embedding = embeddings[i];
          const hash = this.hashText(text);
          this.cache.set(hash, embedding);
          results[index] = embedding;
        }
      } catch (error) {
        this.logger.error(`Failed to generate embeddings: ${error}`);
        throw error;
      }
    }

    return results as number[][];
  }

  /**
   * Calculate cosine similarity between two embeddings
   * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite)
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have the same dimension');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * Find top-k most similar items from a list of embeddings
   */
  findMostSimilar(
    queryEmbedding: number[],
    items: { embedding: number[]; data: any }[],
    topK: number = 5,
    minScore: number = 0.3,
  ): { score: number; data: any }[] {
    const scored = items
      .map((item) => ({
        score: this.cosineSimilarity(queryEmbedding, item.embedding),
        data: item.data,
      }))
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
  }

  /**
   * Clear the in-memory cache
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.debug('Embedding cache cleared');
  }

  /**
   * Check if the service is ready
   */
  isReady(): boolean {
    return this.embeddings !== null;
  }

  /**
   * Get the hash for a text (for external caching)
   */
  getTextHash(text: string): string {
    return this.hashText(text);
  }
}
