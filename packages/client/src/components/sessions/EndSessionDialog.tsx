import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { deleteSession } from '../../lib/api';
import { emitSessionDeleted } from '../../lib/app-websocket';

export interface EndSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
}

export function EndSessionDialog({
  open,
  onOpenChange,
  sessionId,
}: EndSessionDialogProps) {
  const navigate = useNavigate();

  const deleteMutation = useMutation({
    mutationFn: () => deleteSession(sessionId),
    onSuccess: () => {
      // Emit session-deleted locally for immediate UI update
      // WebSocket event will arrive later but will be processed idempotently
      emitSessionDeleted(sessionId);
      onOpenChange(false);
      navigate({ to: '/' });
    },
  });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="End Session"
      description="Are you sure you want to end this session? This will stop all workers and cannot be undone."
      confirmLabel="End Session"
      variant="danger"
      onConfirm={() => deleteMutation.mutate()}
      isLoading={deleteMutation.isPending}
    />
  );
}
