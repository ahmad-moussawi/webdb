import React from 'react';
import { useStudio } from '../../context/StudioContext';
import { CheckCircle2 } from 'lucide-react';

export const Toast: React.FC = () => {
  const { toastMessage } = useStudio();

  return (
    <div
      id="toast"
      className={`studio-toast toast toast-msg ${toastMessage ? 'visible show' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="studio-toast-content">
        <CheckCircle2 size={16} className="studio-toast-icon" />
        <span className="studio-toast-text">{toastMessage || ''}</span>
      </div>
    </div>
  );
};
