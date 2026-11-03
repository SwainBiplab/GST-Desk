import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen">
      <nav className="flex gap-4 border-b p-3">
        <Link to="/shop">Shop</Link>
        <Link to="/books">Books</Link>
      </nav>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  ),
});
