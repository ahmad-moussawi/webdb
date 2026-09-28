import React from 'react';
import { useStudio } from '../../context/StudioContext';
import { getRegisteredDbs } from '../../utils/storage';
import type { VfsType } from '../../types/studio';

export const DbSelector: React.FC = () => {
  const { activeDbName, activeStorage, openDb, setIsNewDbModalOpen } = useStudio();

  const memDbs = getRegisteredDbs('memory');
  const idbDbs = getRegisteredDbs('idb');

  if (activeStorage === 'memory' && !memDbs.includes(activeDbName)) {
    memDbs.push(activeDbName);
  } else if (activeStorage === 'idb' && !idbDbs.includes(activeDbName)) {
    idbDbs.push(activeDbName);
  }

  const currentValue = `${activeStorage}:${activeDbName}`;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val && val.includes(':')) {
      const [storage, name] = val.split(':') as [VfsType, string];
      openDb(name, storage);
    }
  };

  return (
    <div className="explorer-footer-db-row">
      <select
        id="dbSelect"
        className="select-pill"
        style={{ flex: 1, minWidth: 0 }}
        title="Select Database"
        value={currentValue}
        onChange={handleChange}
      >
        <optgroup label="MEMORY (EPHEMERAL)">
          {memDbs.map((name) => (
            <option key={`memory:${name}`} value={`memory:${name}`}>
              {name}
            </option>
          ))}
        </optgroup>
        <optgroup label="INDEXEDDB (PERSISTENT)">
          {idbDbs.map((name) => (
            <option key={`idb:${name}`} value={`idb:${name}`}>
              {name}
            </option>
          ))}
        </optgroup>
      </select>

      <button
        id="openNewDbModalBtn"
        className="btn btn-secondary btn-sm"
        title="Create New Database"
        style={{ padding: '0 8px', height: '24px' }}
        onClick={() => setIsNewDbModalOpen(true)}
      >
        + NEW
      </button>
    </div>
  );
};
