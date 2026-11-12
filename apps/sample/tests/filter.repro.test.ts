import { expect, test } from 'bun:test';
import { GET as crash } from '../src/app/api/tasks/crash/route';
import { GET as listTasks } from '../src/app/api/tasks/route';

test('filtering tasks by status returns only matching tasks', async () => {
  const response = await listTasks(new Request('http://localhost/api/tasks?status=Done'));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.count).toBe(1);
  expect(body.tasks.map((task: { status: string }) => task.status)).toEqual(['Done']);
});

test('the crash route throws when the task is missing', () => {
  expect(() => crash()).toThrow('Task service failed while reading a task.');
});
