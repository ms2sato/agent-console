import { describe, it, expect } from 'bun:test';
import { MessageDetector } from '../message-detector.js';

describe('MessageDetector', () => {
  it('detects a complete message in a single chunk', () => {
    const detector = new MessageDetector();
    const result = detector.processOutput('<<<TO:Worker2>>>hello world<<<END>>>');
    expect(result).toEqual([{ targetWorkerName: 'Worker2', content: 'hello world' }]);
  });

  it('detects multiple messages in a single chunk', () => {
    const detector = new MessageDetector();
    const result = detector.processOutput(
      '<<<TO:A>>>msg1<<<END>>>some text<<<TO:B>>>msg2<<<END>>>'
    );
    expect(result).toEqual([
      { targetWorkerName: 'A', content: 'msg1' },
      { targetWorkerName: 'B', content: 'msg2' },
    ]);
  });

  it('detects a message split across multiple chunks', () => {
    const detector = new MessageDetector();
    expect(detector.processOutput('<<<TO:W')).toEqual([]);
    expect(detector.processOutput('orker>>>hel')).toEqual([]);
    const result = detector.processOutput('lo<<<END>>>');
    expect(result).toEqual([{ targetWorkerName: 'Worker', content: 'hello' }]);
  });

  it('returns empty array when no messages found', () => {
    const detector = new MessageDetector();
    expect(detector.processOutput('regular output')).toEqual([]);
  });

  it('trims whitespace from target name and content', () => {
    const detector = new MessageDetector();
    const result = detector.processOutput('<<<TO: Worker2 >>>  hello  <<<END>>>');
    expect(result).toEqual([{ targetWorkerName: 'Worker2', content: 'hello' }]);
  });

  it('strips ANSI escape sequences before matching', () => {
    const detector = new MessageDetector();
    const result = detector.processOutput('<<<TO:\x1B[32mWorker\x1B[0m>>>hello<<<END>>>');
    expect(result).toEqual([{ targetWorkerName: 'Worker', content: 'hello' }]);
  });

  it('clears buffer when no partial pattern exists', () => {
    const detector = new MessageDetector();
    detector.processOutput('no pattern here');
    // Buffer should be cleared, next message should work fine
    const result = detector.processOutput('<<<TO:X>>>test<<<END>>>');
    expect(result).toEqual([{ targetWorkerName: 'X', content: 'test' }]);
  });

  it('handles buffer overflow by keeping tail', () => {
    const detector = new MessageDetector(100);
    // Fill buffer beyond max
    detector.processOutput('x'.repeat(200));
    // Should still detect messages after overflow
    const result = detector.processOutput('<<<TO:W>>>msg<<<END>>>');
    expect(result).toEqual([{ targetWorkerName: 'W', content: 'msg' }]);
  });

  it('dispose clears the buffer', () => {
    const detector = new MessageDetector();
    detector.processOutput('<<<TO:W>>>partial');
    detector.dispose();
    // After dispose, partial pattern is lost
    const result = detector.processOutput('<<<END>>>');
    expect(result).toEqual([]);
  });
});
