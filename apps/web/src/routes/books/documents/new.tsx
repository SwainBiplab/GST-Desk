import { createFileRoute } from '@tanstack/react-router';

import { EditorRoute } from '@/features/documents/editor-route';

export const Route = createFileRoute('/books/documents/new')({
  validateSearch: (s: Record<string, unknown>) => s,
  component: () => (
    <div data-shell="books">
      <EditorRoute shell="books" />
    </div>
  ),
});
