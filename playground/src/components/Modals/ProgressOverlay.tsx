import React from 'react';
import { useStudio } from '../../context/StudioContext';

export const ProgressOverlay: React.FC = () => {
  const { seedingProgress } = useStudio();

  if (!seedingProgress.visible) return null;

  const pct = seedingProgress.total > 0
    ? Math.min(100, Math.round((seedingProgress.current / seedingProgress.total) * 100))
    : 0;

  return (
    <div id="seedProgressOverlay" className="progress-overlay" style={{ display: 'flex' }}>
      <div className="progress-card">
        <div className="progress-title-row">
          <span id="progressTitle">{seedingProgress.title}</span>
          <span id="progressPercentBadge" className="badge-count">
            {pct}%
          </span>
        </div>
        <div className="progress-bar-track">
          <div
            id="progressBarFill"
            className="progress-bar-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="progress-status-row">
          <span id="progressStepText">{seedingProgress.step}</span>
          <span id="progressCountText">
            {seedingProgress.current.toLocaleString()} / {seedingProgress.total.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
};
