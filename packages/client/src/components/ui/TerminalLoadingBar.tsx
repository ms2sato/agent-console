export function TerminalLoadingBar({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <>
      <style>{`
        @keyframes loading-bar {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(200%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
      <div
        className="absolute top-0 left-0 right-0 h-0.5 z-10 overflow-hidden"
        role="progressbar"
        aria-label="Loading terminal history"
      >
        <div
          className="h-full w-1/3 bg-blue-400 rounded-full"
          style={{
            animation: 'loading-bar 1.5s ease-in-out infinite',
          }}
        />
      </div>
    </>
  );
}
