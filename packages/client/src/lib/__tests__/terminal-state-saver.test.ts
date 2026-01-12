import { describe, it, expect } from 'bun:test';
import { createTerminalStateSaver } from '../terminal-state-saver';

type Snapshot = { value: string };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('terminal-state-saver', () => {
  it('flush saves immediately and clears pending timers', async () => {
    let savedCount = 0;
    const saver = createTerminalStateSaver<Snapshot>(
      () => ({ value: 'snapshot' }),
      () => {
        savedCount += 1;
        return Promise.resolve();
      },
      { throttleMs: 50 }
    );

    saver.flush();
    saver.schedule();
    saver.flush();

    expect(savedCount).toBe(2);
    await wait(60);
    expect(savedCount).toBe(2);
  });

  it('schedules a save after the throttle window', async () => {
    let savedCount = 0;
    const saver = createTerminalStateSaver<Snapshot>(
      () => ({ value: 'snapshot' }),
      () => {
        savedCount += 1;
        return Promise.resolve();
      },
      { throttleMs: 30 }
    );

    saver.flush();
    saver.schedule();

    await wait(10);
    expect(savedCount).toBe(1);

    await wait(30);
    expect(savedCount).toBe(2);
  });

  it('clear cancels scheduled saves', async () => {
    let savedCount = 0;
    const saver = createTerminalStateSaver<Snapshot>(
      () => ({ value: 'snapshot' }),
      () => {
        savedCount += 1;
        return Promise.resolve();
      },
      { throttleMs: 20 }
    );

    saver.flush();
    saver.schedule();
    saver.clear();

    await wait(30);
    expect(savedCount).toBe(1);
  });

  it('skips saving when no snapshot is available', async () => {
    let savedCount = 0;
    const saver = createTerminalStateSaver<Snapshot>(
      () => null,
      () => {
        savedCount += 1;
        return Promise.resolve();
      },
      { throttleMs: 20 }
    );

    saver.flush();
    saver.schedule();

    await wait(30);
    expect(savedCount).toBe(0);
  });
});
