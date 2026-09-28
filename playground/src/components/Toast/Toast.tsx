import React from 'react';
import { useStudio } from '../../context/StudioContext';

export const Toast: React.FC = () => {
  const { toastMessage } = useStudio();

  return (
    <div id="toast" className={`toast ${toastMessage ? 'show' : ''}`}>
      {toastMessage}
    </div>
  );
};
