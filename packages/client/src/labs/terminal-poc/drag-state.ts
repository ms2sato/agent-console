// Drag-enter/leave events bubble from child elements, so a single logical drag
// over the terminal produces many enter/leave pairs. A depth counter nets them
// out: `isDragOver` is true whenever the counter is positive. `drop` resets the
// counter unconditionally (the browser does not emit a matching leave for the
// element the drop lands on).

export type DragAction = 'enter' | 'leave' | 'drop';

export interface DragState {
  count: number;
  isDragOver: boolean;
}

export function reduceDragCounter(count: number, action: DragAction): DragState {
  switch (action) {
    case 'enter': {
      const next = count + 1;
      return { count: next, isDragOver: next > 0 };
    }
    case 'leave': {
      // Clamp so a stray leave (e.g. leaving to a child that never entered)
      // cannot drive the counter negative and latch the overlay open.
      const next = Math.max(0, count - 1);
      return { count: next, isDragOver: next > 0 };
    }
    case 'drop':
      return { count: 0, isDragOver: false };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
