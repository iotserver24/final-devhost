import { expect, test } from 'bun:test';
import { GET } from '../app/api/tasks/crash/route';

test('the crash route returns a response instead of throwing', async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
});
