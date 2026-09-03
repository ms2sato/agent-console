import { describe, it, expect } from 'bun:test';
import { AGENT_KIND_CONTEXT_NOTICES } from '../AgentKindNotice';

describe('AgentKindNotice', () => {
  // The restart dialog's embedded+restart notice was the only registered
  // entry; it was removed once cross-type restart made the restriction
  // obsolete (RestartSessionDialog no longer passes disabledKinds, and
  // NoticeContext is now `never` -- uninhabited). AGENT_KIND_CONTEXT_NOTICES
  // (typed `Record<NoticeContext, ...>`) is therefore the empty object.
  //
  // No component-render test exists here: with NoticeContext uninhabited,
  // there is no valid (kind, context) pair a type-safe caller could ever
  // construct, so exercising <AgentKindNotice> would require an unsafe cast
  // that violates the very invariant the type enforces. Pinning the registry
  // shape below is what guards against a future re-addition slipping in
  // without review.
  it('has no registered notices (Record<never, ...> is the empty object)', () => {
    expect(AGENT_KIND_CONTEXT_NOTICES).toEqual({});
  });
});
