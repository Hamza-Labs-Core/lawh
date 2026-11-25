import { DurableObject } from 'cloudflare:workers';

/** One for each project: will hold live-ping connections (S20). Exists from the first release, so that no
 *  upgrade adds a Durable Object migration. Not reachable yet. */
export class LiveProject extends DurableObject {
  override fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
