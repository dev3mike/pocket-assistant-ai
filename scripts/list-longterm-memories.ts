/**
 * List all long-term memories stored in ChromaDB.
 *
 * Usage:
 *   1. Ensure ChromaDB is running: docker compose up chromadb -d
 *   2. Run: npm run memories:list
 *
 * Optional: CHROMA_HOST (default: http://localhost:8100)
 */

try {
  require('dotenv').config();
} catch {
  // dotenv optional; use env from shell if not installed
}

import { ChromaClient } from 'chromadb';

const CHROMA_HOST = process.env.CHROMA_HOST || 'http://localhost:8100';

function parseChromaUrl(url: string): { host: string; port: number; ssl: boolean } {
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

function parseExtra(extra: unknown): Record<string, unknown> {
  if (typeof extra === 'string' && extra) {
    try {
      return JSON.parse(extra);
    } catch {
      return {};
    }
  }
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    return extra as Record<string, unknown>;
  }
  return {};
}

async function main(): Promise<void> {
  console.log('ChromaDB long-term memories');
  console.log('Host:', CHROMA_HOST);
  console.log('—'.repeat(60));

  const { host, port, ssl } = parseChromaUrl(CHROMA_HOST);
  const client = new ChromaClient({ host, port, ssl });

  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = String(args[0] ?? '');
    if (msg.includes('No embedding function configuration found') || msg.includes('embedding function configuration found for collection')) {
      return;
    }
    origWarn.apply(console, args);
  };

  try {
    const collections = await client.listCollections();
    const memoryCollections = collections.filter(
      (c) => c.name.startsWith('chat_') && c.name.endsWith('_memories'),
    );

    if (memoryCollections.length === 0) {
      console.log('No long-term memory collections found.');
      return;
    }

    let total = 0;
    for (const col of memoryCollections) {
      const chatId = col.name.replace(/^chat_/, '').replace(/_memories$/, '');
      const result = await col.get({
        limit: 10_000,
        include: ['documents', 'metadatas'],
      });

      const ids = result.ids ?? [];
      const documents = result.documents ?? [];
      const metadatas = result.metadatas ?? [];

      if (ids.length === 0) {
        console.log(`\n[Chat ${chatId}] (0 memories)`);
        continue;
      }

      console.log(`\n[Chat ${chatId}] (${ids.length} memor${ids.length === 1 ? 'y' : 'ies'})`);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const content = (documents as (string | null)[])[i] ?? '';
        const meta = ((metadatas as (Record<string, unknown> | null)[])[i] ?? {}) as Record<string, unknown>;
        const category = meta.category ?? '—';
        const source = meta.source ?? '—';
        const createdAt = meta.createdAt ?? '—';
        const tags = meta.tags;
        const extra = parseExtra(meta.extra);
        const extraStr = Object.keys(extra).length ? `\n    extra: ${JSON.stringify(extra)}` : '';
        const tagsStr = Array.isArray(tags) && tags.length ? ` tags: [${(tags as string[]).join(', ')}]` : '';
        console.log(`  • ${id}`);
        console.log(`    ${content.slice(0, 120)}${content.length > 120 ? '...' : ''}`);
        console.log(`    category: ${category}  source: ${source}  createdAt: ${createdAt}${tagsStr}${extraStr}`);
      }
      total += ids.length;
    }

    console.log('\n' + '—'.repeat(60));
    console.log(`Total: ${total} memories across ${memoryCollections.length} chat(s).`);
  } finally {
    console.warn = origWarn;
  }
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
