import { createFileRoute } from '@tanstack/react-router';

import { BooksLayout } from '@/app/components/layouts';

export const Route = createFileRoute('/books')({ component: BooksLayout });
