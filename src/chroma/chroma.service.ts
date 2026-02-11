/**
 * CHROMA SERVICE - Vector database connection and management
 *
 * Manages connection to ChromaDB for storing and searching embeddings.
 * Each chat gets its own collection for memory isolation.
 *
 * If ChromaDB is unavailable, long-term memory features are disabled.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChromaClient, Collection, IncludeEnum, EmbeddingFunction } from 'chromadb';

export interface ChromaDocument {
  id: string;
  content: string;
  metadata: Record<string, any>;
}

export interface ChromaSearchResult {
  id: string;
  content: string;
  metadata: Record<string, any>;
  distance: number;
}

class OpenRouterEmbeddingFunction implements EmbeddingFunction {
  private apiKey: string;

  constructor() {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error('OPENROUTER_API_KEY not set');
    }
    this.apiKey = key;
  }

  async generate(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/text-embedding-3-small',
        input: texts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    return data.data.map((item: { embedding: number[] }) => item.embedding);
  }
}

@Injectable()
export class ChromaService implements OnModuleInit {
  private readonly logger = new Logger(ChromaService.name);
  private client: ChromaClient | null = null;
  private collections: Map<string, Collection> = new Map();
  private isConnected = false;
  private embeddingFunction: OpenRouterEmbeddingFunction | null = null;

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing ChromaDB service...');
    await this.connect();
  }

  /**
   * Parse CHROMA_HOST URL into host, port, ssl for ChromaClient
   */
  private parseChromaUrl(url: string): { host: string; port: number; ssl: boolean } {
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        port: u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 8000,
        ssl: u.protocol === 'https:',
      };
    } catch {
      return { host: 'localhost', port: 8100, ssl: false };
    }
  }

  /**
   * Connect to ChromaDB
   */
  private async connect(): Promise<void> {
    const chromaHost = process.env.CHROMA_HOST || 'http://localhost:8100';
    const { host, port, ssl } = this.parseChromaUrl(chromaHost);

    try {
      // Initialize embedding function first
      this.embeddingFunction = new OpenRouterEmbeddingFunction();

      this.client = new ChromaClient({
        host,
        port,
        ssl,
      });

      // Test connection with heartbeat
      const heartbeat = await this.client.heartbeat();
      this.isConnected = true;
      this.logger.log(`Connected to ChromaDB at ${chromaHost} (heartbeat: ${heartbeat})`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to connect to ChromaDB at ${chromaHost}: ${errorMsg}`);
      this.logger.warn('Long-term memory features will be disabled');
      this.client = null;
      this.isConnected = false;
    }
  }

  /**
   * Check if ChromaDB is available
   */
  isReady(): boolean {
    return this.isConnected && this.client !== null && this.embeddingFunction !== null;
  }

  /**
   * Get or create a collection for a specific chat
   * Collection name: chat_{chatId}_memories
   */
  async getCollection(chatId: string): Promise<Collection | null> {
    if (!this.client || !this.embeddingFunction) {
      return null;
    }

    const collectionName = `chat_${chatId}_memories`;

    if (this.collections.has(collectionName)) {
      return this.collections.get(collectionName)!;
    }

    try {
      // Chroma client logs a warning when the server schema has no/legacy embedding_function
      // (e.g. existing collections). We always pass embeddingFunction, so add/query work; suppress the noise.
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        const msg = args[0]?.toString?.() ?? '';
        if (msg.includes('No embedding function configuration found') || msg.includes('embedding function configuration found for collection')) {
          return;
        }
        origWarn.apply(console, args);
      };
      let collection: Collection;
      try {
        collection = await this.client.getOrCreateCollection({
          name: collectionName,
          metadata: {
            'hnsw:space': 'cosine',
            chatId,
          },
          embeddingFunction: this.embeddingFunction,
        });
      } finally {
        console.warn = origWarn;
      }

      this.collections.set(collectionName, collection);
      return collection;
    } catch (error) {
      this.logger.error(`Failed to get/create collection for chat ${chatId}: ${error}`);
      return null;
    }
  }

  /**
   * Chroma metadata values must be string, number, boolean, null, or string[]/number[]/boolean[].
   * Convert any other value (e.g. object) to JSON string.
   */
  private sanitizeMetadata(metadata: Record<string, any>): Record<string, string | number | boolean | null | string[] | number[] | boolean[]> {
    const out: Record<string, string | number | boolean | null | string[] | number[] | boolean[]> = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (v === null || v === undefined) {
        out[k] = null;
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[k] = v;
      } else if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'string' || typeof v[0] === 'number' || typeof v[0] === 'boolean')) {
        out[k] = v as string[] | number[] | boolean[];
      } else {
        out[k] = JSON.stringify(v);
      }
    }
    return out;
  }

  /**
   * Add documents to a chat's collection
   */
  async addDocuments(chatId: string, documents: ChromaDocument[]): Promise<boolean> {
    const collection = await this.getCollection(chatId);
    if (!collection) {
      return false;
    }

    try {
      await collection.add({
        ids: documents.map((d) => d.id),
        documents: documents.map((d) => d.content),
        metadatas: documents.map((d) => this.sanitizeMetadata(d.metadata)),
      });
      return true;
    } catch (error) {
      this.logger.error(`Failed to add documents for chat ${chatId}: ${error}`);
      return false;
    }
  }

  /**
   * Search for similar documents
   */
  async search(
    chatId: string,
    query: string,
    options: { maxResults?: number; where?: Record<string, any> } = {},
  ): Promise<ChromaSearchResult[]> {
    const collection = await this.getCollection(chatId);
    if (!collection) {
      return [];
    }

    const { maxResults = 5, where } = options;

    try {
      const results = await collection.query({
        queryTexts: [query],
        nResults: maxResults,
        where,
        include: [IncludeEnum.documents, IncludeEnum.metadatas, IncludeEnum.distances],
      });

      if (!results.ids[0] || results.ids[0].length === 0) {
        return [];
      }

      return results.ids[0].map((id, index) => ({
        id,
        content: results.documents[0]?.[index] || '',
        metadata: results.metadatas[0]?.[index] || {},
        distance: results.distances?.[0]?.[index] || 1,
      }));
    } catch (error) {
      this.logger.error(`Search failed for chat ${chatId}: ${error}`);
      return [];
    }
  }

  /**
   * Delete a document by ID
   */
  async deleteDocument(chatId: string, documentId: string): Promise<boolean> {
    const collection = await this.getCollection(chatId);
    if (!collection) {
      return false;
    }

    try {
      await collection.delete({ ids: [documentId] });
      return true;
    } catch (error) {
      this.logger.error(`Failed to delete document ${documentId}: ${error}`);
      return false;
    }
  }

  /**
   * Update a document's content and/or metadata
   */
  async updateDocument(
    chatId: string,
    documentId: string,
    content?: string,
    metadata?: Record<string, any>,
  ): Promise<boolean> {
    const collection = await this.getCollection(chatId);
    if (!collection) {
      return false;
    }

    try {
      await collection.update({
        ids: [documentId],
        documents: content ? [content] : undefined,
        metadatas: metadata ? [this.sanitizeMetadata(metadata)] : undefined,
      });
      return true;
    } catch (error) {
      this.logger.error(`Failed to update document ${documentId}: ${error}`);
      return false;
    }
  }

  /**
   * Get document by ID
   */
  async getDocument(chatId: string, documentId: string): Promise<ChromaDocument | null> {
    const collection = await this.getCollection(chatId);
    if (!collection) {
      return null;
    }

    try {
      const results = await collection.get({
        ids: [documentId],
        include: [IncludeEnum.documents, IncludeEnum.metadatas],
      });

      if (!results.ids || results.ids.length === 0) {
        return null;
      }

      return {
        id: results.ids[0],
        content: results.documents?.[0] || '',
        metadata: results.metadatas?.[0] || {},
      };
    } catch (error) {
      this.logger.error(`Failed to get document ${documentId}: ${error}`);
      return null;
    }
  }

  /**
   * Get all documents in a collection
   */
  async getAllDocuments(chatId: string): Promise<ChromaDocument[]> {
    const collection = await this.getCollection(chatId);
    if (!collection) {
      return [];
    }

    try {
      const results = await collection.get({
        include: [IncludeEnum.documents, IncludeEnum.metadatas],
      });

      if (!results.ids || results.ids.length === 0) {
        return [];
      }

      return results.ids.map((id, index) => ({
        id,
        content: results.documents?.[index] || '',
        metadata: results.metadatas?.[index] || {},
      }));
    } catch (error) {
      this.logger.error(`Failed to get all documents for chat ${chatId}: ${error}`);
      return [];
    }
  }

  /**
   * Delete all documents in a collection (clear memories)
   */
  async clearCollection(chatId: string): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    const collectionName = `chat_${chatId}_memories`;

    try {
      await this.client.deleteCollection({ name: collectionName });
      this.collections.delete(collectionName);
      this.logger.log(`Cleared collection for chat ${chatId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to clear collection for chat ${chatId}: ${error}`);
      return false;
    }
  }

  /**
   * Get collection stats
   */
  async getStats(chatId: string): Promise<{ count: number } | null> {
    const collection = await this.getCollection(chatId);
    if (!collection) {
      return null;
    }

    try {
      const count = await collection.count();
      return { count };
    } catch (error) {
      this.logger.error(`Failed to get stats for chat ${chatId}: ${error}`);
      return null;
    }
  }
}
