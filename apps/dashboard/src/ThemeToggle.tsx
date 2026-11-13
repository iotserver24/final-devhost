'use client';

import { useEffect, useState } from 'react';

export function ThemeToggle() {
  const [theme, setTheme] = useState<'night' | 'day'>(() => (typeof window !== 'undefined' && window.localStorage.getItem('sentinel-theme') === 'day' ? 'day' : 'night'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('sentinel-theme', theme);
  }, [theme]);
  return <button className="button theme-toggle" onClick={() => setTheme(value => (value === 'night' ? 'day' : 'night'))} type="button" aria-label={theme === 'night' ? 'Switch to day mode' : 'Switch to night mode'}>
    {theme === 'night' ? 'Day mode' : 'Night mode'}
  </button>;
}
