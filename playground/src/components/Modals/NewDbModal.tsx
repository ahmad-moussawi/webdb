import React, { useState, useEffect } from 'react';
import { useStudio } from '../../context/StudioContext';
import type { VfsType } from '../../types/studio';

export const NewDbModal: React.FC = () => {
  const { isNewDbModalOpen, setIsNewDbModalOpen, createDb } = useStudio();
  const [dbName, setDbName] = useState<string>('');
  const [vfs, setVfs] = useState<VfsType>('memory');
  const [template, setTemplate] = useState<string>('store_standard');

  useEffect(() => {
    if (isNewDbModalOpen) {
      setDbName(`db_${Date.now().toString().slice(-4)}`);
      setVfs('memory');
      setTemplate('store_standard');
    }
  }, [isNewDbModalOpen]);

  if (!isNewDbModalOpen) return null;

  const handleConfirm = async () => {
    const raw = dbName.trim().toLowerCase();
    const cleanName = raw.replace(/[^a-z0-9_]/g, '_') || `db_${Date.now()}`;
    setIsNewDbModalOpen(false);
    await createDb(cleanName, vfs, template);
  };

  return (
    <div id="newDbModal" className="modal-backdrop" style={{ display: 'flex' }}>
      <div className="modal-card">
        <div className="modal-header">
          <span>CREATE NEW DATABASE</span>
          <button
            id="closeModalBtn"
            className="modal-close-btn"
            onClick={() => setIsNewDbModalOpen(false)}
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label>DATABASE NAME</label>
            <input
              id="modalDbNameInput"
              type="text"
              className="modal-input"
              value={dbName}
              onChange={(e) => setDbName(e.target.value)}
              placeholder="e.g. store_db"
            />
          </div>

          <div className="form-group">
            <label>STORAGE ENGINE (VFS)</label>
            <div className="modal-segmented-vfs">
              <label className="vfs-radio-label">
                <input
                  type="radio"
                  name="modalVfs"
                  value="memory"
                  checked={vfs === 'memory'}
                  onChange={() => setVfs('memory')}
                />
                <span>Memory (Fast, Ephemeral)</span>
              </label>
              <label className="vfs-radio-label">
                <input
                  type="radio"
                  name="modalVfs"
                  value="idb"
                  checked={vfs === 'idb'}
                  onChange={() => setVfs('idb')}
                />
                <span>IndexedDB (Persistent)</span>
              </label>
            </div>
          </div>

          <div className="form-group">
            <label>INITIAL DATA TEMPLATE</label>
            <div className="template-list">
              <label className="template-option-label">
                <input
                  type="radio"
                  name="modalTemplate"
                  value="empty"
                  checked={template === 'empty'}
                  onChange={() => setTemplate('empty')}
                />
                <div className="template-info">
                  <strong>Empty Database</strong>
                  <span>Create a blank database with zero tables</span>
                </div>
              </label>

              <label className="template-option-label">
                <input
                  type="radio"
                  name="modalTemplate"
                  value="store_standard"
                  checked={template === 'store_standard'}
                  onChange={() => setTemplate('store_standard')}
                />
                <div className="template-info">
                  <strong>E-Commerce Store (1,500 rows)</strong>
                  <span>Categories, Products, Customers, Orders, Reviews</span>
                </div>
              </label>

              <label className="template-option-label">
                <input
                  type="radio"
                  name="modalTemplate"
                  value="store_large"
                  checked={template === 'store_large'}
                  onChange={() => setTemplate('store_large')}
                />
                <div className="template-info">
                  <strong>Large Scale Store (10,000 rows)</strong>
                  <span>Benchmark scale store dataset</span>
                </div>
              </label>

              <label className="template-option-label">
                <input
                  type="radio"
                  name="modalTemplate"
                  value="store_real_api"
                  checked={template === 'store_real_api'}
                  onChange={() => setTemplate('store_real_api')}
                />
                <div className="template-info">
                  <strong>Real Products (DummyJSON API)</strong>
                  <span>Fetch real-world products over HTTP</span>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button
            id="cancelModalBtn"
            className="btn btn-secondary"
            onClick={() => setIsNewDbModalOpen(false)}
          >
            CANCEL
          </button>
          <button
            id="confirmCreateDbBtn"
            className="btn btn-primary"
            onClick={handleConfirm}
          >
            CREATE DATABASE
          </button>
        </div>
      </div>
    </div>
  );
};
