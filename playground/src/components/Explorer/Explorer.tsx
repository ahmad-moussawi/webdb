import React from 'react';
import { useStudio } from '../../context/StudioContext';
import { TableTree } from './TableTree';
import { DbSelector } from './DbSelector';
import { ThemeSwitcher } from './ThemeSwitcher';

export const Explorer: React.FC = () => {
  const { isExplorerOpen, explorerWidth } = useStudio();

  if (!isExplorerOpen) return null;

  return (
    <div
      className="ide-panel panel-explorer"
      style={{ width: `${explorerWidth}px`, flexBasis: `${explorerWidth}px` }}
    >
      <TableTree />
      <div className="explorer-footer">
        <DbSelector />
        <ThemeSwitcher />
      </div>
    </div>
  );
};
