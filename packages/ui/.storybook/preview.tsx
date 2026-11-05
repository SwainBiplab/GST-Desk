import type { Decorator, Preview } from '@storybook/react';
import * as React from 'react';

import { pseudo } from '@gst/i18n';

import './preview.css';

const withTokens: Decorator = (Story, ctx) => {
  const { theme, density } = ctx.globals as { theme: string; density: string };
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-density', density);
  }, [theme, density]);
  return (
    <div className="bg-bg p-4 text-fg">
      <Story />
    </div>
  );
};

/**
 * The locale toolbar: a real language sets the document language (fonts and line height follow), and
 * `pseudo` makes every text on the page about 40 percent longer, to see what a long Tamil or Bengali
 * label would do to the layout.
 */
const originals = new WeakMap<Text, string>();
const withLocale: Decorator = (Story, ctx) => {
  const { locale } = ctx.globals as { locale: string };
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    document.documentElement.lang = locale === 'pseudo' ? 'en' : locale;
    const el = root.current;
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const original = originals.get(n) ?? n.data;
      if (!originals.has(n)) originals.set(n, original);
      n.data = locale === 'pseudo' && original.trim() ? pseudo(original) : original;
    }
  });
  return (
    <div ref={root}>
      <Story />
    </div>
  );
};

const preview: Preview = {
  decorators: [withTokens, withLocale],
  initialGlobals: { theme: 'light', density: 'comfortable', locale: 'en' },
  globalTypes: {
    theme: {
      toolbar: { title: 'Theme', items: ['light', 'dark'], dynamicTitle: true },
    },
    density: {
      toolbar: { title: 'Density', items: ['comfortable', 'compact'], dynamicTitle: true },
    },
    locale: {
      toolbar: {
        title: 'Locale',
        items: ['en', 'hi', 'ta', 'bn', 'gu', 'mr', 'pseudo'],
        dynamicTitle: true,
      },
    },
  },
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
};

export default preview;
