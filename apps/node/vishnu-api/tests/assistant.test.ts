import { afterEach, describe, expect, it, vi } from 'vitest';
const simulation = vi.hoisted(() => ({ calls: 1, projected: 1000, consumed: 0 }));
vi.mock('@strands-agents/sdk', async importOriginal => {
  const sdk = await importOriginal<typeof import('@strands-agents/sdk')>();
  return {
    ...sdk,
    Agent: class {
      async *stream() {
        for (let i = 0; i < simulation.calls; i++) {
          yield { type: 'beforeModelCallEvent', projectedInputTokens: simulation.projected };
          simulation.consumed++;
        }
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
  afterEach(() => {
    simulation.calls = 1;
    simulation.projected = 1000;
    simulation.consumed = 0;
    vi.restoreAllMocks();
  });
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
    const abort = new AbortController();
    abort.abort();
    await expect(
      createAssistant({ ...sources, mesh }, { VISHNU_AGENT_ENABLED: 'true' }).run(
        'a',
        { prompt: 'hello', contextKey: '' },
        () => {},
        abort.signal
      )
    ).rejects.toThrow();
    expect(mesh).not.toHaveBeenCalled();
  });
  it('limits a user across new conversations and reopens the rolling-hour window', async () => {
    const service = createAssistant(sources, { VISHNU_AGENT_ENABLED: 'true' });
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    for (let i = 0; i < 12; i++)
      await service.run(
        'a',
        { prompt: 'hello', contextKey: '' },
        () => {},
        new AbortController().signal
      );
    await expect(
      service.run(
        'a',
        { prompt: 'new chat', contextKey: '' },
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow('hourly limit');
    clock.mockReturnValue(start + 3_600_001);
    await service.run(
      'a',
      { prompt: 'hello', contextKey: '' },
      () => {},
      new AbortController().signal
    );
  });
  it('stops before a seventh model invocation or an oversized model prompt', async () => {
    simulation.calls = 7;
    await expect(
      createAssistant(sources, { VISHNU_AGENT_ENABLED: 'true' }).run(
        'a',
        { prompt: 'hello', contextKey: '' },
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow('model budget');
    expect(simulation.consumed).toBe(6);
    simulation.calls = 1;
    simulation.projected = 16_001;
    simulation.consumed = 0;
    await expect(
      createAssistant(sources, { VISHNU_AGENT_ENABLED: 'true' }).run(
        'a',
        { prompt: 'hello', contextKey: '' },
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow('model budget');
    expect(simulation.consumed).toBe(0);
  });
  it('enforces process capacity across users independently of conversation count', async () => {
    const service = createAssistant(sources, { VISHNU_AGENT_ENABLED: 'true' });
    for (let user = 0; user < 6; user++) {
      let conversationId: string | undefined;
      for (let turn = 0; turn < 10; turn++)
        await service.run(
          String(user),
          { prompt: 'hello', contextKey: '', conversationId },
          event => {
            if (event.type === 'done') conversationId = event.conversationId;
          },
          new AbortController().signal
        );
    }
    await expect(
      service.run(
        'new-user',
        { prompt: 'hello', contextKey: '' },
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow('hourly capacity');
  });
});
