import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

export const Route = createFileRoute('/books/')({ component: Page });

function Page() {
  const { t } = useTranslation();
  return <h1 className="text-2xl font-semibold">{t('books')}</h1>;
}
