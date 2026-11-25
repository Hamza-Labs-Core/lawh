import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('has the Durable Object class, which does nothing yet', async () => {
  const stub = env.LIVE.get(env.LIVE.idFromName('p1'));
  expect((await stub.fetch('https://live/')).status).toBe(404);
});
