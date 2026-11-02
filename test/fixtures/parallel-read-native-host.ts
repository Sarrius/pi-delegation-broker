import assert from 'node:assert/strict';
import {qualificationResponse} from './qualification-response.mjs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';

const usage = { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function emit(stream: any, model: any, content: any[], reason = 'stop') {
  const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content, usage, stopReason: reason, timestamp: Date.now() };
  stream.push({ type: 'start', partial: message });
  for (const [index, block] of content.entries()) {
    if (block.type === 'toolCall') {
      stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
      stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(block.arguments), partial: message });
      stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial: message });
    } else if (block.type === 'text') {
      stream.push({ type: 'text_start', contentIndex: index, partial: message });
      stream.push({ type: 'text_delta', contentIndex: index, delta: block.text, partial: message });
      stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial: message });
    }
  }
  stream.push({ type: 'done', reason, message });
  stream.end(message);
}
export default function parallelReadNativeHost(pi: any) {
  let childRequests = 0;
  let readResults = 0;
  const model = { id: 'claude-sonnet-4-6', name: 'Scripted read fixture', reasoning: false,
    input: ['text'], contextWindow: 200000, maxTokens: 8192, cost: usage.cost };
  pi.on('session_start', (_event: any, ctx: any) => assert.equal(ctx.controllerProvider, undefined));
  pi.registerProvider('anthropic', {
    name: 'Scripted child read provider', baseUrl: 'https://read-fixture.invalid',
    api: 'anthropic-messages', apiKey: 'fixture-native', models: [model],
    streamSimple(selected: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        options?.onResponse?.({ status: 200, headers: { 'request-id': 'parallel-read-fixture' } });
        const qualification=qualificationResponse(context);
        if(qualification){emit(stream,selected,qualification.content,qualification.reason);return;}
        childRequests++;
        const results = context.messages.filter((message: any) => message.role === 'toolResult');
        if (results.length) {
          readResults = results.length;
          const complete = readResults === 3 && results.every((entry: any) =>
            JSON.stringify(entry.content).includes('BATCH_READ_DATA'));
          emit(stream, selected, [{ type: 'text', text: complete ? 'BATCH_CHILD_OK' : 'BATCH_CHILD_BAD' }]);
        } else {
          emit(stream, selected, [1, 2, 3].map((id) => ({ type: 'toolCall', id: `batch-read-${id}`,
            name: 'read', arguments: { path: process.env.BATCH_READ_FILE } })), 'toolUse');
        }
      });
      return stream;
    },
  });
  pi.registerProvider('standalone-parent', {
    name: 'Scripted parent provider', baseUrl: 'https://parent-fixture.invalid',
    api: 'standalone-parent-api', apiKey: 'fixture-parent', models: [{ ...model, id: 'parent' }],
    streamSimple(selected: any, context: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const result = [...context.messages].reverse().find((message: any) => message.role === 'toolResult');
        if (result) {
          writeFileSync(process.env.BATCH_READ_RESULT!, JSON.stringify({ childRequests, readResults, result }));
          emit(stream, selected, [{ type: 'text', text: JSON.stringify(result.content).includes('BATCH_CHILD_OK')
            ? 'BATCH_PARENT_OK' : 'BATCH_PARENT_BAD' }]);
        } else emit(stream, selected, [{ type: 'toolCall', id: 'batch-delegate', name: 'delegate', arguments: {
          task: `Read ${process.env.BATCH_READ_FILE} and report BATCH_CHILD_OK`, wait: true,
          tier: 'standard', thinking: 'off',
          work: { taskClass: 'lookup', deliverable: 'Verified fixture marker',
            benefit: 'Prove parallel read results do not masquerade as separate no-progress turns',
            parentWork: 'Collect and check the child report', maxAttempts: 1 },
        } }], 'toolUse');
      });
      return stream;
    },
  });
}
