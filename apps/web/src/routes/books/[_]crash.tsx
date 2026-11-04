import { createFileRoute } from '@tanstack/react-router';

/**
 * Diagnostics route: throws on render so the error boundary and "copy diagnostics" can be exercised
 * (used by the e2e suite). Harmless in production: it only shows the same fallback any crash would.
 */
export const Route = createFileRoute('/books/_crash')({
  component: function Crash(): never {
    throw new Error('Deliberate crash for ' + 'sharma@example.com' + ' 9876543210');
  },
});
