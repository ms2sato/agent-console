import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { deleteSession } from '../../lib/api';

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
