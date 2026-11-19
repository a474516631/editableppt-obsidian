import { expect, it } from 'vitest';

import { setImmediate } from '../src/set-immediate';

it('runs callbacks later, in order, with their arguments', async () => {
  const seen: string[] = [];
  await new Promise<void>((resolve) => {
    setImmediate((label: string) => seen.push(label), 'first');
    setImmediate((label: string, last: boolean) => {
      seen.push(label);
      if (last) resolve();
    }, 'second', true);
    seen.push('sync');
  });
  expect(seen).toEqual(['sync', 'first', 'second']);
});
