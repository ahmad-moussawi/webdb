import React from 'react';
import { useStudio } from '../../context/StudioContext';
import type { ThemeMode } from '../../types/studio';

export const ThemeSwitcher: React.FC = () => {
  const { themeMode, setThemeMode } = useStudio();

  const themes: { val: ThemeMode; label: string; title: string }[] = [
    { val: 'auto', label: 'auto', title: 'System Theme' },
    { val: 'dark', label: 'dark', title: 'Dark Theme' },
    { val: 'light', label: 'light', title: 'Light Theme' },
  ];

  return (
    <div className="explorer-footer-theme-row">
      <span className="theme-row-label">Theme:</span>
      <div className="theme-segmented-box" id="themeSegmentedBox">
        {themes.map((t) => (
          <button
            key={t.val}
            type="button"
            className={`theme-segment-btn ${themeMode === t.val ? 'active' : ''}`}
            data-theme-val={t.val}
            title={t.title}
            onClick={() => setThemeMode(t.val)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
};
