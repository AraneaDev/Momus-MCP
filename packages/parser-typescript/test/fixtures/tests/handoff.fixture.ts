import { describe, expect, it, vi } from 'vitest';

interface Engine {
  run(id: string): Promise<{ ok: boolean }>;
}

const MockEngine = { mockImplementation: vi.fn() };

describe('handoff scope isolation', () => {
  it('binds a chained-config mock and hands it off by name', async () => {
    const mockRun = vi.fn().mockResolvedValue({ ok: true });
    MockEngine.mockImplementation(() => ({ run: mockRun }) as unknown as Engine);
    expect(mockRun).toBeDefined();
  });

  it('reuses the same name in a separate scope without colliding', async () => {
    const mockRun = vi.fn().mockReturnValue(1);
    MockEngine.mockImplementation(() => ({ run: mockRun }) as unknown as Engine);
    expect(mockRun).toBeDefined();
  });

  it('hands off an inline mock created inside an object literal', async () => {
    const engine: Engine = {
      run: vi.fn().mockResolvedValue({ ok: false }),
    };
    MockEngine.mockImplementation(() => engine);
    expect(engine.run).toBeDefined();
  });

  it('hands off a mock through an array element', async () => {
    const mockRun = vi.fn();
    const list = [mockRun];
    expect(list).toHaveLength(1);
  });

  it('marks a spy reachable when its target object is handed off', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const opts = { signal: controller.signal };
    expect(opts.signal).toBe(controller.signal);
    expect(removeListener).toHaveBeenCalled();
  });
});
