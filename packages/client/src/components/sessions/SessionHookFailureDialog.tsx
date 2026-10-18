import { HookCommandFailureDialog } from '../repositories/HookCommandFailureDialog';
import type { SessionHookFailure, SessionHookFailureKind } from '../../hooks/useSessionStopTasks';

const COPY: Record<SessionHookFailureKind, { title: string; intro: string }> = {
  pause: {
    title: 'Pause Command Failed',
    intro: 'The session was paused, but the pause command failed. Resources such as containers may still be running.',
  },
  resume: {
    title: 'Resume Command Failed',
    intro: 'The session was resumed, but the resume command failed. Resources such as containers may not have started.',
  },
};

interface SessionHookFailureDialogProps {
  failure: SessionHookFailure | null;
  onClose: () => void;
}

/** Root-level dialog for a failed pause/resume hook command. */
export function SessionHookFailureDialog({ failure, onClose }: SessionHookFailureDialogProps) {
  const copy = failure ? COPY[failure.kind] : COPY.pause;
  const intro = failure?.sessionTitle ? `${failure.sessionTitle}: ${copy.intro}` : copy.intro;
  return (
    <HookCommandFailureDialog
      result={failure?.result ?? null}
      title={copy.title}
      intro={intro}
      onClose={onClose}
    />
  );
}
