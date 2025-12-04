import { createRootRoute, Outlet, Link } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        padding: '12px 20px',
        borderBottom: '1px solid #333',
        display: 'flex',
        alignItems: 'center',
        gap: '20px',
      }}>
        <Link
          to="/"
          style={{
            color: '#fff',
            textDecoration: 'none',
            fontSize: '1.2rem',
            fontWeight: 'bold',
          }}
        >
          Claude Code Web Console
        </Link>
      </header>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </main>
    </div>
  );
}
