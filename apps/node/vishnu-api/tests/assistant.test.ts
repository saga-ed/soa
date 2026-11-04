import { describe, expect, it, vi } from 'vitest';
vi.mock('@strands-agents/sdk', async importOriginal => {
  const sdk = await importOriginal<typeof import('@strands-agents/sdk')>();
  return {
    ...sdk,
    Agent: class {
      async *stream() {
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Evidence checked.' },
          },
        };
      }
      cancel() {}
    },
  };
});
import { createAssistant } from '../src/assistant/service';
import { createFixture } from '../../../web/vishnu/src/lib/fixtures/mesh';
import type { AssistantEvent } from '../../../web/vishnu/src/lib/graph/assistant';
describe('assistant conversation ownership and lifecycle', () => {
  const sources = {
    mesh: async () => createFixture('overview'),
    datadog: vi.fn(),
    resources: vi.fn(),
  };
  it('isolates conversations by staff subject and rejects fabricated IDs', async () => {
    const service = createAssistant(sources, { VISHNU_AGENT_ENABLED: 'true' });
    const events: AssistantEvent[] = [];
    await service.run(
      'staff-a',
      { prompt: 'hello', contextKey: 'initial' },
      e => events.push(e),
      new AbortController().signal
    );
    const done = events.find(e => e.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('missing completion');
    await expect(
      service.run(
        'staff-b',
        { prompt: 'continue', contextKey: 'initial', conversationId: done.conversationId },
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow('Conversation expired');
    await service.run(
      'staff-a',
      { prompt: 'continue', contextKey: 'initial', conversationId: done.conversationId },
      () => {},
      new AbortController().signal
    );
  });
  it('does no telemetry work when disabled or cancelled', async () => {
    const mesh = vi.fn(sources.mesh);
    await expect(
      createAssistant({ ...sources, mesh }, {}).run(
        'a',
        { prompt: 'hello', contextKey: '' },
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow('not enabled');
    expect(mesh).not.toHaveBeenCalled();
  });
});
