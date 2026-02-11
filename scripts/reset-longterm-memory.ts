/**
 * Reset (delete) all long-term memories in ChromaDB.
 *
 * Usage:
 *   1. Ensure ChromaDB is running: docker compose up chromadb -d
 *   2. Run: npm run memories:reset
 *   3. Optional: reset only one chat: npm run memories:reset -- --chat=132995226
 *
 * Optional env: CHROMA_HOST (default: http://localhost:8100)
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

async function main(): Promise<void> {
  const chatArg = process.argv.find((a) => a.startsWith('--chat='));
  const onlyChatId = chatArg ? chatArg.replace('--chat=', '').trim() : null;

  console.log('ChromaDB long-term memory reset');
  console.log('Host:', CHROMA_HOST);
  if (onlyChatId) {
    console.log('Scope: chat', onlyChatId, 'only');
  } else {
    console.log('Scope: ALL chats');
  }
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

    if (onlyChatId) {
      const name = `chat_${onlyChatId}_memories`;
      const found = memoryCollections.find((c) => c.name === name);
      if (!found) {
        console.log(`No collection found for chat ${onlyChatId}.`);
        return;
      }
      await client.deleteCollection({ name });
      console.log(`Deleted long-term memory for chat ${onlyChatId}.`);
      return;
    }

    if (memoryCollections.length === 0) {
      console.log('No long-term memory collections found.');
      return;
    }

    for (const col of memoryCollections) {
      await client.deleteCollection({ name: col.name });
      const chatId = col.name.replace(/^chat_/, '').replace(/_memories$/, '');
      console.log('Deleted:', col.name, `(chat ${chatId})`);
    }
    console.log('—'.repeat(60));
    console.log(`Reset complete. ${memoryCollections.length} collection(s) deleted.`);
  } finally {
    console.warn = origWarn;
  }
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
