import { useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';

interface CopyButtonProps {
  text: string;
}

/**
 * Copies `text` to the clipboard (with the non-secure-context fallback in
 * `copyToClipboard`); a refused write is reported, never thrown.
 */
export function CopyButton({ text }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = async () => {
    try {
      await copyToClipboard(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <>
      <button type="button" className="btn btn-primary text-sm shrink-0" onClick={handleCopy}>
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      {state === 'failed' && (
        <span className="text-sm text-red-300">Could not copy automatically. Select the text and copy it manually.</span>
      )}
    </>
  );
}
