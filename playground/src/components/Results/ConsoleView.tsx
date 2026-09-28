import React from 'react';
import { useStudio } from '../../context/StudioContext';

export const ConsoleView: React.FC = () => {
  const { logs } = useStudio();

  return (
    <div id="consoleView" className="console-view" style={{ display: 'block' }}>
      {logs.length === 0 ? 'No console logs captured for this query.' : logs.join('\n')}
    </div>
  );
};
