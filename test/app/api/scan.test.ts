import { expect, it } from 'vitest';
import { ApiError } from '../../../src/shared/errors';
import { secretScanner } from '../../../src/app/api/scan';

// Built at run time, so that no key-shaped text is in this repository.
const KEY = `AKIA${'A'.repeat(16)}`;

/** The position the scanner gives for bytes cut into these chunks, or null when it lets them through unchanged. */
async function scan(text: string, cuts: number[]): Promise<number | null> {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [i, from] of [0, ...cuts].entries()) controller.enqueue(bytes.slice(from, cuts[i] ?? bytes.length));
      controller.close();
    },
  });
  try {
    expect(await new Response(body.pipeThrough(secretScanner())).text()).toBe(text);
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.details!.position as number;
    throw error;
  }
}

const everyCut = (length: number) => Array.from({ length: length - 1 }, (_, i) => i + 1).flatMap((cut) => [[cut], cut + 1 < length ? [cut, cut + 1] : [cut]]);

it('takes longer words that only begin or end like a key, wherever the chunks are cut', async () => {
  const text = `${'y'.repeat(300)} ${KEY}BCDE zz${KEY} ${'y'.repeat(300)}`;
  for (const cuts of everyCut(text.length)) expect(await scan(text, cuts), cuts.join()).toBeNull();
});

it('finds a key at its position, wherever the chunks are cut', async () => {
  for (const [text, at] of [[`${'y '.repeat(150)}${KEY} ${'y '.repeat(150)}`, 300], [`${KEY} x`, 0], [`x ${KEY}`, 2]] as const) {
    expect(await scan(text, [])).toBe(at);
    for (const cuts of everyCut(text.length)) expect(await scan(text, cuts), cuts.join()).toBe(at);
  }
});

it('never gives the whole of a refused file to its reader', async () => {
  for (const cuts of [[], [5], [300], [315]]) {
    const bytes = new TextEncoder().encode(`${'y '.repeat(150)}${KEY}`);
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const [i, from] of [0, ...cuts].entries()) c.enqueue(bytes.slice(from, cuts[i] ?? bytes.length)); c.close(); } });
    let got = 0;
    await expect(body.pipeThrough(secretScanner()).pipeTo(new WritableStream({ write(chunk) { got += chunk.byteLength; } }))).rejects.toThrow();
    expect(got).toBeLessThan(bytes.length);
  }
});

it('finds a key cut into single bytes, and one after a word that only looks like one', async () => {
  const text = `${'y '.repeat(150)}${KEY}B ${KEY}.`;
  expect(await scan(text, Array.from({ length: text.length - 1 }, (_, i) => i + 1))).toBe(text.lastIndexOf(KEY));
});
