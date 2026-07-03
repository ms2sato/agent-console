import { describe, expect, it } from 'bun:test';
import { reduceDragCounter } from '../drag-state';

describe('reduceDragCounter', () => {
  it('turns the overlay on for the first enter', () => {
    expect(reduceDragCounter(0, 'enter')).toEqual({ count: 1, isDragOver: true });
  });

  it('stays on across nested (bubbled) enters', () => {
    expect(reduceDragCounter(1, 'enter')).toEqual({ count: 2, isDragOver: true });
  });

  it('stays on while inner leaves still leave a positive depth', () => {
    expect(reduceDragCounter(2, 'leave')).toEqual({ count: 1, isDragOver: true });
  });

  it('turns off when the last leave returns depth to zero', () => {
    expect(reduceDragCounter(1, 'leave')).toEqual({ count: 0, isDragOver: false });
  });

  it('clamps a stray leave at zero (never latches negative)', () => {
    const once = reduceDragCounter(0, 'leave');
    expect(once).toEqual({ count: 0, isDragOver: false });
    // A subsequent enter still turns the overlay on (would stay off if the
    // counter had gone negative).
    expect(reduceDragCounter(once.count, 'enter')).toEqual({ count: 1, isDragOver: true });
  });

  it('drop resets depth and hides the overlay regardless of prior depth', () => {
    expect(reduceDragCounter(3, 'drop')).toEqual({ count: 0, isDragOver: false });
    expect(reduceDragCounter(0, 'drop')).toEqual({ count: 0, isDragOver: false });
  });
});
