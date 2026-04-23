// Minimal opencode SDK spike: spawn the server, list providers, close.
// No API key needed — just proves the sdk → binary → RPC path works.
// Usage: npx tsx scripts/opencode-hello.ts

import { createOpencode } from '@opencode-ai/sdk';

const { client, server } = await createOpencode({ port: 4196 });
console.log('server listening:', server.url);

try {
  const providers = await client.config.providers();
  const list = (providers.data as { providers?: unknown[] } | undefined)?.providers ?? [];
  console.log(`providers available: ${list.length}`);
  // Print a few so we can see the shape.
  for (const p of list.slice(0, 5)) {
    const pp = p as { id?: string; name?: string };
    console.log(` - ${pp.id} (${pp.name ?? ''})`);
  }

  const created = await client.session.create({ body: {} });
  const id = (created.data as { id?: string } | undefined)?.id;
  console.log('session created:', id);

  console.log('OK');
} finally {
  server.close();
}
