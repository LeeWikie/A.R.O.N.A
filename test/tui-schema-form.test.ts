import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectForm, formCancelled } from '../src/tui/schema-form.js';

test('workflow forms collect server fields, nested arrays and valid scalar values', async () => {
  const choices = ['add', 'done', 'true', 'skip'];
  const prompts = ['a.txt', 'b.txt', 'not-a-number', '3'];
  const notes: string[] = [];
  const value = await collectForm({ choose: async () => choices.shift(), prompt: async () => prompts.shift(), note: text => notes.push(text) }, {
    type: 'object', required: ['paths', 'enabled', 'retries'], properties: {
      paths: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      enabled: { type: 'boolean' }, retries: { type: 'integer', minimum: 1, maximum: 5 }, optional: { type: 'string' },
    },
  }, 'Workflow');
  assert.deepEqual(value, { paths: ['a.txt', 'b.txt'], enabled: true, retries: 3 });
  assert.equal(notes.length, 1);
  assert.equal(choices.length, 0); assert.equal(prompts.length, 0);
});

test('workflow cancellation is distinct from an empty or false input and blocks partial submission', async () => {
  const host = { choose: async () => undefined, prompt: async () => undefined, note() {} };
  assert.equal(await collectForm(host, { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }, 'Input'), formCancelled);
  assert.equal(await collectForm(host, { const: false }, 'Fixed value'), false);
  assert.equal(await collectForm(host, { enum: ['only'] }, 'Only value'), 'only');
});
