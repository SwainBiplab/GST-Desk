import type { Decorator, Preview } from '@storybook/react';
import * as React from 'react';

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

const preview: Preview = {
  decorators: [withTokens],
  initialGlobals: { theme: 'light', density: 'comfortable' },
  globalTypes: {
    theme: {
      toolbar: { title: 'Theme', items: ['light', 'dark'], dynamicTitle: true },
    },
    density: {
      toolbar: { title: 'Density', items: ['comfortable', 'compact'], dynamicTitle: true },
    },
  },
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
};

export default preview;
