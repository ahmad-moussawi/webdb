import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useStudio } from '../../context/StudioContext';
import { inspectBufferPool, PoolSlotInfo, PoolStats } from '../../utils/poolInspector';
import { discoverDatabasePages } from '../../utils/pageInspector';
import {
  RotateCw,
  Grid3X3,
  LayoutGrid,
  Table as TableIcon,
  Flame,
  Pin,
  Clock,
  HardDrive,
  Database,
  Search,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Info,
  ChevronRight,
  ArrowRight,
  Layers,
  Cpu,
} from 'lucide-react';

export const BufferPoolInspector: React.FC = () => {
  const { db, tables, inspectPage, showToast } = useStudio();

  const [poolData, setPoolData] = useState<{ stats: PoolStats; slots: PoolSlotInfo[] }>({
    stats: {
      totalSlots: 0,
      residentCount: 0,
      freeSlotsCount: 0,
      dirtyCount: 0,
      pinnedCount: 0,
      clockHand: 0,
      arenaUsedBytes: 0,
      arenaMaxBytes: 0,
      totalPoolMemoryBytes: 0,
      dirtyPercent: 0,
      residentPercent: 0,
    },
    slots: [],
  });

  const [viewMode, setViewMode] = useState<'squares' | 'grid' | 'table'>('squares');
  const [filterType, setFilterType] = useState<'all' | 'resident' | 'dirty' | 'pinned' | 'free'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(0);
  const [isFlushing, setIsFlushing] = useState<boolean>(false);

  // Refresh buffer pool state with both fast sync and deep hierarchy resolution
  const refreshPool = useCallback(async () => {
    if (!db) return;
    try {
      // Fast initial pass using resident pool metadata & table descriptors
      const initial = inspectBufferPool(db, tables);
      setPoolData(initial);

      // Deep hierarchy resolution across all tables, leaf chains, and routing branches
      try {
        const discovered = await discoverDatabasePages(db, tables);
        const map = new Map<number, string>();
        for (const p of discovered) {
          if (p.tableName) map.set(p.pageId, p.tableName);
        }
        const full = inspectBufferPool(db, tables, map);
        setPoolData(full);
      } catch (e) {
        // Deep discovery fallback
      }
    } catch (err: any) {
      console.warn('Error inspecting buffer pool:', err);
    }
  }, [db, tables]);

  useEffect(() => {
    refreshPool();
  }, [refreshPool]);

  // Flush all dirty pages to disk
  const handleFlushAll = async () => {
    const driver = db?.driver || db?.pool;
    if (!driver || typeof driver.flushAllDirty !== 'function') {
      showToast('Flush not supported by current storage driver.');
      return;
    }
    setIsFlushing(true);
    try {
      const dirtyCountBefore = poolData.stats.dirtyCount;
      await driver.flushAllDirty();
      refreshPool();
      showToast(`Flushed ${dirtyCountBefore} dirty page(s) to storage.`);
    } catch (err: any) {
      showToast(`Flush failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsFlushing(false);
    }
  };

  // Flush a single slot
  const handleFlushSlot = async (slotIdx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const driver = db?.driver || db?.pool;
    if (!driver || typeof driver.flushSlot !== 'function') return;
    setIsFlushing(true);
    try {
      await driver.flushSlot(slotIdx);
      refreshPool();
      showToast(`Flushed slot #${slotIdx} to storage.`);
    } catch (err: any) {
      showToast(`Flush failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsFlushing(false);
    }
  };

  // Filter slots
  const filteredSlots = useMemo(() => {
    return poolData.slots.filter((slot) => {
      // Type filter
      if (filterType === 'resident' && slot.pageId === 0) return false;
      if (filterType === 'dirty' && !slot.isDirty) return false;
      if (filterType === 'pinned' && !slot.isPinned) return false;
      if (filterType === 'free' && slot.pageId > 0) return false;

      // Text search
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchesSlot = `slot ${slot.slotIndex}`.includes(query) || String(slot.slotIndex) === query;
        const matchesPage = `page ${slot.pageId}`.includes(query) || String(slot.pageId) === query;
        const matchesTable = slot.tableName?.toLowerCase().includes(query) || false;
        const matchesType = slot.pageTypeName?.toLowerCase().includes(query) || false;
        return matchesSlot || matchesPage || matchesTable || matchesType;
      }

      return true;
    });
  }, [poolData.slots, filterType, searchQuery]);

  // Selected slot detail
  const selectedSlot = useMemo(() => {
    if (selectedSlotIndex === null) return null;
    return poolData.slots.find((s) => s.slotIndex === selectedSlotIndex) || null;
  }, [poolData.slots, selectedSlotIndex]);

  // Format bytes helper
  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  return (
    <div className="pool-inspector-container">
      {/* Top Overview Metric Cards */}
      <div className="pool-stats-banner">
        <div className="pool-stat-card">
          <div className="stat-icon-wrapper blue">
            <Layers size={18} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Buffer Capacity</div>
            <div className="stat-value">
              {poolData.stats.totalSlots}{' '}
              <span className="stat-sub">slots ({formatBytes(poolData.stats.totalSlots * 4096)})</span>
            </div>
          </div>
        </div>

        <div className="pool-stat-card">
          <div className="stat-icon-wrapper green">
            <Database size={18} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Resident Pages</div>
            <div className="stat-value">
              {poolData.stats.residentCount}{' '}
              <span className="stat-sub">/ {poolData.stats.totalSlots} ({poolData.stats.residentPercent}%)</span>
            </div>
          </div>
        </div>

        <div className={`pool-stat-card ${poolData.stats.dirtyCount > 0 ? 'highlight-dirty' : ''}`}>
          <div className="stat-icon-wrapper orange">
            <Flame size={18} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Dirty Pages</div>
            <div className="stat-value">
              {poolData.stats.dirtyCount}{' '}
              <span className="stat-sub">unflushed ({poolData.stats.dirtyPercent}%)</span>
            </div>
          </div>
          {poolData.stats.dirtyCount > 0 && (
            <button
              className="pool-flush-all-btn"
              onClick={handleFlushAll}
              disabled={isFlushing}
              title="Flush all dirty pages to persistent storage"
            >
              <RotateCw size={12} className={isFlushing ? 'spin' : ''} />
              Flush All
            </button>
          )}
        </div>

        <div className="pool-stat-card">
          <div className="stat-icon-wrapper purple">
            <Pin size={18} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Pinned Pages</div>
            <div className="stat-value">
              {poolData.stats.pinnedCount}{' '}
              <span className="stat-sub">protected</span>
            </div>
          </div>
        </div>

        <div className="pool-stat-card">
          <div className="stat-icon-wrapper cyan">
            <Clock size={18} />
          </div>
          <div className="stat-content">
            <div className="stat-label">CLOCK Eviction</div>
            <div className="stat-value">
              Hand #{poolData.stats.clockHand ?? 0}{' '}
              <span className="stat-sub">Second-Chance</span>
            </div>
          </div>
        </div>

        <div className="pool-stat-card">
          <div className="stat-icon-wrapper gray">
            <Cpu size={18} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Query Arena</div>
            <div className="stat-value">
              {formatBytes(poolData.stats.arenaUsedBytes)}{' '}
              <span className="stat-sub">/ {formatBytes(poolData.stats.arenaMaxBytes)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Control Toolbar */}
      <div className="pool-toolbar">
        <div className="pool-filters">
          <button
            className={`pool-filter-btn ${filterType === 'all' ? 'active' : ''}`}
            onClick={() => setFilterType('all')}
          >
            All <span className="filter-pill">{poolData.stats.totalSlots}</span>
          </button>
          <button
            className={`pool-filter-btn ${filterType === 'resident' ? 'active' : ''}`}
            onClick={() => setFilterType('resident')}
          >
            Resident <span className="filter-pill">{poolData.stats.residentCount}</span>
          </button>
          <button
            className={`pool-filter-btn dirty-filter ${filterType === 'dirty' ? 'active' : ''}`}
            onClick={() => setFilterType('dirty')}
          >
            Dirty <span className="filter-pill orange">{poolData.stats.dirtyCount}</span>
          </button>
          <button
            className={`pool-filter-btn ${filterType === 'pinned' ? 'active' : ''}`}
            onClick={() => setFilterType('pinned')}
          >
            Pinned <span className="filter-pill purple">{poolData.stats.pinnedCount}</span>
          </button>
          <button
            className={`pool-filter-btn ${filterType === 'free' ? 'active' : ''}`}
            onClick={() => setFilterType('free')}
          >
            Free <span className="filter-pill">{poolData.stats.freeSlotsCount}</span>
          </button>
        </div>

        <div className="pool-actions">
          <div className="pool-search-box">
            <Search size={13} className="search-icon" />
            <input
              type="text"
              placeholder="Filter slot, page ID, table..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pool-search-input"
            />
            {searchQuery && (
              <button className="clear-search-btn" onClick={() => setSearchQuery('')}>
                &times;
              </button>
            )}
          </div>

          <div className="pool-view-toggle">
            <button
              className={`view-btn ${viewMode === 'squares' ? 'active' : ''}`}
              onClick={() => setViewMode('squares')}
              title="Compact Squares View (Status Colors)"
            >
              <Grid3X3 size={14} />
            </button>
            <button
              className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="Slot Cards View"
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className={`view-btn ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
              title="Slot Details Table View"
            >
              <TableIcon size={14} />
            </button>
          </div>

          <button className="pool-refresh-btn" onClick={refreshPool} title="Refresh Buffer Pool State">
            <RotateCw size={13} />
          </button>
        </div>
      </div>

      {/* Main Content Area: Squares / Cards / Table + Selected Slot Inspector */}
      <div className="pool-main-content">
        <div className="pool-slots-area">
          {viewMode === 'squares' ? (
            <div className="pool-squares-view-wrapper">
              <div className="pool-squares-section-title">
                <div className="squares-title-left">
                  <span className="squares-title-text">BUFFER POOL STATUS MATRIX</span>
                  <span className="squares-count-pill">{filteredSlots.length} Slots</span>
                </div>
                <span className="pool-squares-sub-hint">
                  Click any square to inspect slot details • Hover for metrics
                </span>
              </div>

              <div className="pool-status-squares-grid">
                {filteredSlots.map((slot) => {
                  const isSelected = selectedSlotIndex === slot.slotIndex;
                  const isClockHand = slot.slotIndex === poolData.stats.clockHand;
                  const isResident = slot.pageId > 0;

                  let statusClass = 'status-free';
                  let statusLabel = 'Free / Unassigned';
                  if (slot.isDirty && slot.isPinned) {
                    statusClass = 'status-dirty-pinned';
                    statusLabel = `Dirty (gen #${slot.dirtyGeneration}) & Pinned (${slot.pinCount})`;
                  } else if (slot.isDirty) {
                    statusClass = 'status-dirty';
                    statusLabel = `Dirty (gen #${slot.dirtyGeneration}) - Unflushed`;
                  } else if (slot.isPinned) {
                    statusClass = 'status-pinned';
                    statusLabel = `Pinned (${slot.pinCount}) - Eviction Protected`;
                  } else if (isResident) {
                    statusClass = 'status-clean';
                    statusLabel = `Clean (Resident, Ref Bit: ${slot.refBit})`;
                  }

                  const tooltip = `Slot #${slot.slotIndex}${isResident ? ` • Page ${slot.pageId}` : ' • Empty Slot'}\nStatus: ${statusLabel}\n${slot.tableName ? `Table: ${slot.tableName}\n` : ''}${slot.pageTypeName ? `Type: ${slot.pageTypeName}\n` : ''}${isResident ? `Fullness: ${slot.usagePercent}% (${slot.usedBytes || 0} B)\nCLOCK Ref Bit: ${slot.refBit}` : 'Available for cache allocation'}${isClockHand ? '\n🧭 CLOCK Sweeper Hand Position' : ''}`;

                  return (
                    <div
                      key={slot.slotIndex}
                      className={`pool-status-square ${statusClass} ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedSlotIndex(slot.slotIndex)}
                      title={tooltip}
                    >
                      {isClockHand && (
                        <span className="clock-hand-marker" title="Eviction CLOCK Hand pointer" />
                      )}
                      <span className="square-slot-num">{slot.slotIndex}</span>
                    </div>
                  );
                })}
              </div>

              {filteredSlots.length === 0 && (
                <div className="pool-no-results">
                  <Info size={20} />
                  <span>No buffer pool slots match your filter criteria.</span>
                </div>
              )}

              {/* Status Legend */}
              <div className="pool-squares-legend">
                <div className="legend-items">
                  <div className="legend-item">
                    <span className="pool-chip status-clean" />
                    <span>Clean (Resident)</span>
                  </div>
                  <div className="legend-item">
                    <span className="pool-chip status-dirty" />
                    <span>Dirty (Unflushed)</span>
                  </div>
                  <div className="legend-item">
                    <span className="pool-chip status-pinned" />
                    <span>Pinned</span>
                  </div>
                  <div className="legend-item">
                    <span className="pool-chip status-dirty-pinned" />
                    <span>Dirty + Pinned</span>
                  </div>
                  <div className="legend-item">
                    <span className="pool-chip status-free" />
                    <span>Free Slot</span>
                  </div>
                  <div className="legend-item">
                    <span className="pool-chip clock-hand-chip">
                      <span className="mini-clock-dot" />
                    </span>
                    <span>CLOCK Hand (#{(poolData.stats.clockHand ?? 0)})</span>
                  </div>
                </div>
              </div>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="pool-slot-grid">
              {filteredSlots.map((slot) => {
                const isSelected = selectedSlotIndex === slot.slotIndex;
                const isClockHand = slot.slotIndex === poolData.stats.clockHand;
                const isResident = slot.pageId > 0;

                return (
                  <div
                    key={slot.slotIndex}
                    className={`pool-slot-card ${isSelected ? 'selected' : ''} ${
                      slot.isDirty ? 'is-dirty' : ''
                    } ${slot.isPinned ? 'is-pinned' : ''} ${!isResident ? 'is-free' : ''}`}
                    onClick={() => setSelectedSlotIndex(slot.slotIndex)}
                  >
                    <div className="slot-card-header">
                      <div className="slot-num-badge">
                        #{slot.slotIndex}
                        {isClockHand && (
                          <span className="clock-hand-dot" title="Eviction CLOCK Hand pointing here">
                            ⏱
                          </span>
                        )}
                      </div>

                      <div className="slot-header-badges">
                        {slot.isDirty && (
                          <span className="slot-badge dirty" title={`Dirty (gen #${slot.dirtyGeneration})`}>
                            <Flame size={10} /> DIRTY
                          </span>
                        )}
                        {slot.isPinned && (
                          <span className="slot-badge pinned" title={`Pinned (count: ${slot.pinCount})`}>
                            <Pin size={10} /> PIN
                          </span>
                        )}
                        {isResident && (
                          <span
                            className={`slot-badge ref ${slot.refBit ? 'ref-high' : 'ref-low'}`}
                            title={`CLOCK Ref Bit: ${slot.refBit} (${
                              slot.refBit ? 'Second chance active' : 'Next eviction victim'
                            })`}
                          >
                            REF:{slot.refBit}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="slot-card-body">
                      {isResident ? (
                        <>
                          <div className="slot-page-title">
                            <span className="page-id-text">Page {slot.pageId}</span>
                            {slot.tableName && (
                              <span className="page-table-tag" title={`Table: ${slot.tableName}`}>
                                {slot.tableName}
                              </span>
                            )}
                          </div>
                          <div className="slot-type-name">{slot.pageTypeName}</div>

                          <div className="slot-usage-wrapper">
                            <div className="slot-usage-bar-bg">
                              <div
                                className={`slot-usage-bar-fill ${
                                  slot.isDirty ? 'dirty-bar' : 'clean-bar'
                                }`}
                                style={{ width: `${Math.max(4, slot.usagePercent || 0)}%` }}
                              />
                            </div>
                            <div className="slot-usage-text">
                              <span>{slot.usagePercent}% used</span>
                              <span>{slot.cellCount ? `${slot.cellCount} items` : ''}</span>
                            </div>
                          </div>

                          {slot.rawSnippetHex && (
                            <div className="slot-hex-snippet" title="First 16 bytes in slot">
                              {slot.rawSnippetHex}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="slot-empty-state">
                          <span className="empty-label">Empty Slot</span>
                          <span className="empty-sub">Available for cache allocation</span>
                        </div>
                      )}
                    </div>

                    {isResident && (
                      <div className="slot-card-footer">
                        <button
                          className="slot-action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            inspectPage(slot.pageId);
                          }}
                          title={`Inspect Page ${slot.pageId} in Pages tab`}
                        >
                          Inspect Page <ExternalLink size={11} />
                        </button>

                        {slot.isDirty && (
                          <button
                            className="slot-flush-btn"
                            onClick={(e) => handleFlushSlot(slot.slotIndex, e)}
                            title="Flush this slot to disk"
                          >
                            Flush
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredSlots.length === 0 && (
                <div className="pool-no-results">
                  <Info size={20} />
                  <span>No buffer pool slots match your filter criteria.</span>
                </div>
              )}
            </div>
          ) : (
            /* Table View */
            <div className="pool-table-wrapper">
              <table className="pool-table">
                <thead>
                  <tr>
                    <th>Slot #</th>
                    <th>Page ID</th>
                    <th>Table</th>
                    <th>Page Type</th>
                    <th>Status</th>
                    <th>Pins</th>
                    <th>Ref Bit</th>
                    <th>Dirty Gen</th>
                    <th>Buffer Offset</th>
                    <th>Utilization</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSlots.map((slot) => {
                    const isSelected = selectedSlotIndex === slot.slotIndex;
                    const isResident = slot.pageId > 0;
                    return (
                      <tr
                        key={slot.slotIndex}
                        className={`${isSelected ? 'selected-row' : ''} ${
                          slot.isDirty ? 'dirty-row' : ''
                        }`}
                        onClick={() => setSelectedSlotIndex(slot.slotIndex)}
                      >
                        <td className="slot-idx-cell">
                          #{slot.slotIndex}
                          {slot.slotIndex === poolData.stats.clockHand && (
                            <span className="table-clock-badge" title="Eviction CLOCK Hand">
                              ⏱
                            </span>
                          )}
                        </td>
                        <td className="page-id-cell">
                          {isResident ? <strong>Page {slot.pageId}</strong> : <span className="muted">—</span>}
                        </td>
                        <td>{slot.tableName ? <span className="tbl-pill">{slot.tableName}</span> : <span className="muted">—</span>}</td>
                        <td className="type-cell">{isResident ? slot.pageTypeName : <span className="muted">Empty</span>}</td>
                        <td>
                          {slot.isDirty ? (
                            <span className="slot-badge dirty">
                              <Flame size={10} /> DIRTY
                            </span>
                          ) : isResident ? (
                            <span className="slot-badge clean">CLEAN</span>
                          ) : (
                            <span className="slot-badge free">FREE</span>
                          )}
                        </td>
                        <td>
                          {slot.pinCount > 0 ? (
                            <span className="slot-badge pinned">
                              <Pin size={10} /> {slot.pinCount}
                            </span>
                          ) : (
                            <span className="muted">0</span>
                          )}
                        </td>
                        <td>
                          {isResident ? (
                            <span className={`slot-badge ref ${slot.refBit ? 'ref-high' : 'ref-low'}`}>
                              {slot.refBit}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>{slot.dirtyGeneration > 0 ? `#${slot.dirtyGeneration}` : <span className="muted">0</span>}</td>
                        <td className="offset-cell">0x{slot.offset.toString(16).padStart(6, '0')}</td>
                        <td>
                          {isResident ? (
                            <div className="table-usage-bar">
                              <div
                                className="table-usage-fill"
                                style={{ width: `${slot.usagePercent || 0}%` }}
                              />
                              <span className="table-usage-text">{slot.usagePercent}%</span>
                            </div>
                          ) : (
                            <span className="muted">0%</span>
                          )}
                        </td>
                        <td className="table-actions-cell">
                          {isResident && (
                            <div className="row-actions-group">
                              <button
                                className="table-action-link"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  inspectPage(slot.pageId);
                                }}
                                title="Inspect in Pages Tab"
                              >
                                Inspect <ChevronRight size={12} />
                              </button>
                              {slot.isDirty && (
                                <button
                                  className="table-action-flush"
                                  onClick={(e) => handleFlushSlot(slot.slotIndex, e)}
                                  title="Flush Slot to Disk"
                                >
                                  Flush
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Selected Slot Details Sidebar */}
        {selectedSlot && (
          <div className="pool-slot-detail-pane">
            <div className="detail-pane-header">
              <div className="detail-title">
                <Database size={15} />
                <span>
                  Slot #{selectedSlot.slotIndex} {selectedSlot.pageId > 0 ? `(Page ${selectedSlot.pageId})` : '(Free)'}
                </span>
              </div>
              {selectedSlot.slotIndex === poolData.stats.clockHand && (
                <span className="clock-hand-tag">
                  <Clock size={11} /> CLOCK HAND
                </span>
              )}
            </div>

            <div className="detail-pane-body">
              {/* Status Tags */}
              <div className="detail-section">
                <div className="detail-section-title">State & Flags</div>
                <div className="detail-badges-row">
                  {selectedSlot.isDirty ? (
                    <span className="slot-badge dirty large">
                      <Flame size={12} /> DIRTY (Generation #{selectedSlot.dirtyGeneration})
                    </span>
                  ) : selectedSlot.pageId > 0 ? (
                    <span className="slot-badge clean large">
                      <CheckCircle2 size={12} /> CLEAN
                    </span>
                  ) : (
                    <span className="slot-badge free large">FREE SLOT</span>
                  )}

                  {selectedSlot.isPinned ? (
                    <span className="slot-badge pinned large">
                      <Pin size={12} /> PINNED ({selectedSlot.pinCount} active ref{selectedSlot.pinCount > 1 ? 's' : ''})
                    </span>
                  ) : (
                    <span className="slot-badge unpinned large">UNPINNED</span>
                  )}

                  {selectedSlot.pageId > 0 && (
                    <span className={`slot-badge ref large ${selectedSlot.refBit ? 'ref-high' : 'ref-low'}`}>
                      REF BIT = {selectedSlot.refBit}{' '}
                      ({selectedSlot.refBit ? 'Second chance' : 'Eviction candidate'})
                    </span>
                  )}
                </div>
              </div>

              {/* Memory Address & Size */}
              <div className="detail-section">
                <div className="detail-section-title">Physical Memory</div>
                <div className="detail-kv-grid">
                  <div className="detail-kv">
                    <span className="kv-label">Start Offset:</span>
                    <span className="kv-value mono">
                      0x{selectedSlot.offset.toString(16).padStart(8, '0')}
                    </span>
                  </div>
                  <div className="detail-kv">
                    <span className="kv-label">End Offset:</span>
                    <span className="kv-value mono">
                      0x{(selectedSlot.offset + 4096).toString(16).padStart(8, '0')}
                    </span>
                  </div>
                  <div className="detail-kv">
                    <span className="kv-label">Slot Size:</span>
                    <span className="kv-value">4,096 bytes (4 KB)</span>
                  </div>
                  <div className="detail-kv">
                    <span className="kv-label">Allocated Bytes:</span>
                    <span className="kv-value">{selectedSlot.usedBytes || 0} bytes ({selectedSlot.usagePercent || 0}%)</span>
                  </div>
                </div>
              </div>

              {/* Page Information */}
              {selectedSlot.pageId > 0 && (
                <div className="detail-section">
                  <div className="detail-section-title">Page Identity</div>
                  <div className="detail-kv-grid">
                    <div className="detail-kv">
                      <span className="kv-label">Page ID:</span>
                      <span className="kv-value highlight">{selectedSlot.pageId}</span>
                    </div>
                    <div className="detail-kv">
                      <span className="kv-label">Page Type:</span>
                      <span className="kv-value">{selectedSlot.pageTypeName}</span>
                    </div>
                    <div className="detail-kv">
                      <span className="kv-label">Associated Table:</span>
                      <span className="kv-value">{selectedSlot.tableName || 'N/A'}</span>
                    </div>
                    <div className="detail-kv">
                      <span className="kv-label">Cell / Item Count:</span>
                      <span className="kv-value">{selectedSlot.cellCount ?? 'N/A'}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Hex Preview */}
              {selectedSlot.rawSnippetHex && (
                <div className="detail-section">
                  <div className="detail-section-title">Raw Slot Bytes (Header 16B)</div>
                  <div className="detail-hex-box mono">{selectedSlot.rawSnippetHex}</div>
                </div>
              )}

              {/* Educational info on Buffer Pool & Eviction */}
              <div className="detail-section note-box">
                <div className="note-title">
                  <Info size={13} />
                  <span>How Buffer Pool Works</span>
                </div>
                <div className="note-text">
                  {selectedSlot.isPinned ? (
                    <p>
                      <strong>Pinned Protection:</strong> This slot has a pin count of{' '}
                      {selectedSlot.pinCount}. Pinned pages cannot be evicted by the CLOCK replacement
                      sweep while active transactions or cursors hold locks on them.
                    </p>
                  ) : selectedSlot.isDirty ? (
                    <p>
                      <strong>Dirty Writeback:</strong> Modifications have occurred in this slot (Generation{' '}
                      #{selectedSlot.dirtyGeneration}). When evicted or flushed, changes are written back
                      through the Block I/O layer to persistent VFS.
                    </p>
                  ) : (
                    <p>
                      <strong>Second-Chance CLOCK:</strong> If memory pressure triggers eviction, unpinned
                      slots with <code>REF=1</code> get their bit cleared to <code>0</code>. Slots with{' '}
                      <code>REF=0</code> are evicted immediately without re-reading from disk if clean.
                    </p>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="detail-actions-footer">
                {selectedSlot.pageId > 0 && (
                  <button
                    className="detail-primary-btn"
                    onClick={() => inspectPage(selectedSlot.pageId)}
                  >
                    Inspect Full Page {selectedSlot.pageId} <ArrowRight size={13} />
                  </button>
                )}
                {selectedSlot.isDirty && (
                  <button
                    className="detail-flush-btn"
                    onClick={() => handleFlushSlot(selectedSlot.slotIndex)}
                  >
                    <Flame size={13} /> Flush This Slot to Disk
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
