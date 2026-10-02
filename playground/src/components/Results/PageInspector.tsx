import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useStudio } from '../../context/StudioContext';
import { VerticalSplitter } from '../Common/Splitters';
import {
  discoverDatabasePages,
  parsePage,
  getByteCategory,
  getPageTypeRgbColor,
  getPageHeatColorByUtilization,
  buildBTreeHierarchy,
  PAGE_TYPE_NAMES,
  DiscoveredPage,
  ParsedPage,
  DecodedCell,
  ColumnByteRange,
  BTreeNode,
} from '../../utils/pageInspector';
import {
  RotateCw,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Layers,
  Binary,
  Table as TableIcon,
  LayoutGrid,
  FolderTree,
  ArrowRight,
  Search,
  ExternalLink,
} from 'lucide-react';
import { BTreeGraphView } from './BTreeGraphView';

export const PageInspector: React.FC = () => {
  const {
    db,
    tables,
    selectedPageId,
    setSelectedPageId,
    inspectPage,
    activeStorage,
  } = useStudio();

  const [discoveredPages, setDiscoveredPages] = useState<DiscoveredPage[]>([]);
  const [parsedPage, setParsedPage] = useState<ParsedPage | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [jumpPageInput, setJumpPageInput] = useState<string>(String(selectedPageId));
  const [highlightedCell, setHighlightedCell] = useState<DecodedCell | null>(null);
  const [pinnedCellIndex, setPinnedCellIndex] = useState<number | null>(null);
  const [hoveredColumnRange, setHoveredColumnRange] = useState<ColumnByteRange | null>(null);
  const [hoveredByteOffset, setHoveredByteOffset] = useState<number | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'split' | 'hex' | 'records' | 'heatmap' | 'tree'>('split');

  // Split view resizable panel state
  const hexScrollerRef = useRef<HTMLDivElement>(null);
  const inspectorBodyRef = useRef<HTMLDivElement>(null);

  const [recordsPanelWidth, setRecordsPanelWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('webdb_page_records_width');
      if (saved) {
        const parsed = Number(saved);
        if (!isNaN(parsed) && parsed >= 240) return parsed;
      }
    } catch {}
    return 540;
  });

  const handleRecordsPanelDrag = useCallback((newWidth: number) => {
    const containerWidth = inspectorBodyRef.current?.getBoundingClientRect().width || window.innerWidth;
    const maxW = Math.max(300, containerWidth - 320);
    const clamped = Math.max(240, Math.min(newWidth, maxW));
    setRecordsPanelWidth(clamped);
    try {
      localStorage.setItem('webdb_page_records_width', String(clamped));
    } catch {}
  }, []);

  const scrollToHexOffset = useCallback((byteOffset: number) => {
    if (byteOffset < 0 || isNaN(byteOffset)) return;
    const lineOffset = Math.floor(byteOffset / 16) * 16;
    const el = document.getElementById(`hex-line-${lineOffset}`);
    const scroller = hexScrollerRef.current;
    if (el && scroller) {
      const scrollerRect = scroller.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const targetScrollTop =
        scroller.scrollTop +
        (elRect.top - scrollerRect.top) -
        scrollerRect.height / 2 +
        elRect.height / 2;
      scroller.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: 'smooth',
      });
    }
  }, []);

  // B-Tree hierarchy state
  const [btreeRoot, setBtreeRoot] = useState<BTreeNode | null>(null);

  // Load all available pages in database
  const refreshPagesList = useCallback(async () => {
    if (!db) return;
    try {
      const list = await discoverDatabasePages(db, tables);
      setDiscoveredPages(list);
    } catch (err: any) {
      console.warn('Error discovering pages:', err);
    }
  }, [db, tables]);

  // Load and parse the currently selected page
  const loadCurrentPage = useCallback(async () => {
    if (!db) return;
    setLoading(true);
    setError(null);
    try {
      const parsed = await parsePage(db, selectedPageId, tables, discoveredPages);
      if (!parsed) {
        setError(`Page ${selectedPageId} could not be read or does not exist.`);
        setParsedPage(null);
      } else {
        setParsedPage(parsed);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to parse page');
      setParsedPage(null);
    } finally {
      setLoading(false);
    }
  }, [db, selectedPageId, tables, discoveredPages]);

  // Build B-Tree Hierarchy when entering Tree tab
  useEffect(() => {
    if (activeSubTab === 'tree' && db) {
      buildBTreeHierarchy(db, tables, discoveredPages).then((root) => {
        setBtreeRoot(root);
      });
    }
  }, [activeSubTab, db, tables, discoveredPages]);

  useEffect(() => {
    refreshPagesList();
  }, [refreshPagesList]);

  useEffect(() => {
    setJumpPageInput(String(selectedPageId));
    setHighlightedCell(null);
    setPinnedCellIndex(null);
    setHoveredColumnRange(null);
    setHoveredByteOffset(null);
    loadCurrentPage();
  }, [selectedPageId, loadCurrentPage]);

  const handlePrevPage = () => {
    if (selectedPageId > 1) {
      setSelectedPageId(selectedPageId - 1);
    }
  };

  const handleNextPage = () => {
    const total = parsedPage?.header?.totalPages || discoveredPages.length || 500;
    if (selectedPageId < total) {
      setSelectedPageId(selectedPageId + 1);
    }
  };

  const handleJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseInt(jumpPageInput, 10);
    if (!isNaN(val) && val >= 1) {
      setSelectedPageId(val);
    }
  };

  // Generate 256 lines of 16-byte hex dump
  const hexLines = useMemo(() => {
    if (!parsedPage || !parsedPage.bytes) return [];
    const lines: Array<{
      offset: number;
      offsetHex: string;
      bytes: Array<{ index: number; val: number; hex: string; char: string }>;
    }> = [];

    const raw = parsedPage.bytes;
    for (let lineOffset = 0; lineOffset < raw.length; lineOffset += 16) {
      const lineBytes: Array<{ index: number; val: number; hex: string; char: string }> = [];
      for (let i = 0; i < 16; i++) {
        const byteIndex = lineOffset + i;
        if (byteIndex < raw.length) {
          const val = raw[byteIndex];
          const hex = val.toString(16).padStart(2, '0');
          const char = val >= 32 && val <= 126 ? String.fromCharCode(val) : '·';
          lineBytes.push({ index: byteIndex, val, hex, char });
        }
      }
      lines.push({
        offset: lineOffset,
        offsetHex: lineOffset.toString(16).padStart(4, '0'),
        bytes: lineBytes,
      });
    }
    return lines;
  }, [parsedPage]);

  // Compute memory distribution bar segments
  const memorySegments = parsedPage?.memoryDistribution?.segments || [];
  const totalPageSize = 4096;

  // Active cell highlighting helper (pinned or hovered)
  const activeHighlighted = useMemo(() => {
    if (pinnedCellIndex !== null && parsedPage) {
      if (parsedPage.columnCatalogDescriptors && parsedPage.columnCatalogDescriptors.length > 0) {
        const desc = parsedPage.columnCatalogDescriptors.find((c) => c.columnIndex === pinnedCellIndex);
        if (desc) {
          return { cellIndex: desc.columnIndex, offset: desc.rawOffset, length: 72 };
        }
      }
      return parsedPage.cells.find((c) => c.cellIndex === pinnedCellIndex) || null;
    }
    return highlightedCell;
  }, [pinnedCellIndex, highlightedCell, parsedPage]);

  // Resolve active table for slotted row decoding and column display
  const activeTable = useMemo(() => {
    if (parsedPage?.associatedTable && parsedPage.associatedTable.columns?.length) {
      return parsedPage.associatedTable;
    }
    const summary = discoveredPages.find((p) => p.pageId === selectedPageId);
    if (summary?.tableName) {
      const matched = tables.find((t) => t.name.toLowerCase() === summary.tableName!.toLowerCase());
      if (matched && matched.columns?.length) return matched;
    }
    if (tables.length === 1 && parsedPage?.header.pageType === 0x0D) {
      return tables[0];
    }
    return undefined;
  }, [parsedPage, discoveredPages, selectedPageId, tables]);

  const schemaColumns = activeTable?.columns || [];

  // Active page summary for sidebar details in heatmap view
  const activePageSummary = useMemo(() => {
    return (
      discoveredPages.find((p) => p.pageId === selectedPageId) || {
        pageId: selectedPageId,
        label: `Page ${selectedPageId}`,
        pageType: parsedPage?.header?.pageType ?? -1,
        role: 'unknown' as const,
        usagePercent: parsedPage
          ? Math.round(((4096 - (parsedPage.memoryDistribution.freeBytes || 0)) / 4096) * 100)
          : 0,
        usedBytes: parsedPage
          ? 4096 - (parsedPage.memoryDistribution.freeBytes || 0)
          : 0,
        freeBytes: parsedPage?.memoryDistribution?.freeBytes || 0,
        cellCount: parsedPage?.cells?.length || 0,
      }
    );
  }, [discoveredPages, selectedPageId, parsedPage]);

  // Summary stats for Heatmap view
  const heatmapStats = useMemo(() => {
    const totalCount = discoveredPages.length;
    let totalUsed = 0;
    let leafCount = 0;
    let freeCount = 0;
    let catCount = 0;

    for (const p of discoveredPages) {
      totalUsed += p.usedBytes || 0;
      if (p.role === 'leaf' || p.role === 'root') leafCount++;
      else if (p.role === 'free') freeCount++;
      else if (p.role === 'catalog') catCount++;
    }

    const totalCapacity = totalCount * 4096;
    const overallUtilPercent = totalCapacity > 0 ? Math.round((totalUsed / totalCapacity) * 100) : 0;

    return {
      totalCount,
      totalBytes: totalCapacity,
      totalUsed,
      overallUtilPercent,
      leafCount,
      freeCount,
      catCount,
    };
  }, [discoveredPages]);



  return (
    <div className="page-inspector-root">
      {/* --- TOP CONTROL TOOLBAR --- */}
      <div className="page-inspector-toolbar">
        <div className="page-inspector-nav-group">
          {/* Page Dropdown */}
          <div className="page-selector-wrapper">
            <Layers size={13} className="page-nav-icon" />
            <select
              className="page-select-dropdown"
              value={selectedPageId}
              onChange={(e) => setSelectedPageId(Number(e.target.value))}
            >
              {discoveredPages.map((p) => (
                <option key={p.pageId} value={p.pageId}>
                  {p.label} {p.usagePercent !== undefined ? `(${p.usagePercent}%)` : ''}
                </option>
              ))}
              {!discoveredPages.some((p) => p.pageId === selectedPageId) && (
                <option value={selectedPageId}>Page {selectedPageId} (Custom)</option>
              )}
            </select>
          </div>

          {/* Stepper Navigation: Previous / Page Jump / Next */}
          <div className="page-stepper-group">
            <button
              className="page-stepper-btn"
              title="Previous Page"
              disabled={selectedPageId <= 1}
              onClick={handlePrevPage}
            >
              <ChevronLeft size={13} />
            </button>
            <form onSubmit={handleJumpSubmit} style={{ display: 'inline-flex' }}>
              <input
                type="text"
                className="page-jump-input"
                value={jumpPageInput}
                onChange={(e) => setJumpPageInput(e.target.value)}
                onBlur={handleJumpSubmit}
                title="Page number (press Enter to jump)"
              />
            </form>
            <button
              className="page-stepper-btn"
              title="Next Page"
              onClick={handleNextPage}
            >
              <ChevronRight size={13} />
            </button>
          </div>

          {/* Refresh Button */}
          <button
            className="page-refresh-btn"
            title="Reload Page Data"
            onClick={() => {
              refreshPagesList();
              loadCurrentPage();
            }}
          >
            <RotateCw size={12} className={loading ? 'spin' : ''} />
          </button>
        </div>

        {/* Status / Page Meta Badges (Subtle & Uniform) */}
        <div className="page-inspector-meta-group">
          {parsedPage && (
            <>
              <span
                className="page-meta-badge type-badge"
                style={{
                  color: getPageTypeRgbColor(parsedPage.header.pageType ?? -1, 1),
                  borderColor: getPageTypeRgbColor(parsedPage.header.pageType ?? -1, 0.3),
                  backgroundColor: getPageTypeRgbColor(parsedPage.header.pageType ?? -1, 0.08),
                }}
              >
                {parsedPage.header.pageTypeName}
              </span>
              {activeTable && (
                <span className="page-meta-badge table-badge">
                  <TableIcon size={11} style={{ marginRight: '4px' }} />
                  {activeTable.name}
                </span>
              )}
              <span className="page-meta-badge size-badge">
                4,096 B
              </span>
              <span className="page-meta-badge storage-badge">
                {activeStorage.toUpperCase()}
              </span>
            </>
          )}

          {/* Sub-tab view toggles */}
          <div className="view-mode-toggle-group">
            <button
              className={`view-mode-btn ${activeSubTab === 'split' ? 'active' : ''}`}
              title="Split View (Hex + Slotted Table)"
              onClick={() => setActiveSubTab('split')}
            >
              SPLIT
            </button>
            <button
              className={`view-mode-btn ${activeSubTab === 'hex' ? 'active' : ''}`}
              title="Full Hex Viewer"
              onClick={() => setActiveSubTab('hex')}
            >
              HEX
            </button>
            <button
              className={`view-mode-btn ${activeSubTab === 'records' ? 'active' : ''}`}
              title="Full Slotted Records / Catalog Table"
              onClick={() => setActiveSubTab('records')}
            >
              RECORDS
            </button>
            <button
              className={`view-mode-btn ${activeSubTab === 'heatmap' ? 'active' : ''}`}
              title="Color-Coded Heatmap Grid"
              onClick={() => setActiveSubTab('heatmap')}
            >
              <LayoutGrid size={11} style={{ marginRight: '4px' }} />
              HEATMAP
            </button>
            <button
              className={`view-mode-btn ${activeSubTab === 'tree' ? 'active' : ''}`}
              title="B-Tree Index & Database Hierarchy Tree"
              onClick={() => setActiveSubTab('tree')}
            >
              <FolderTree size={11} style={{ marginRight: '4px' }} />
              TREE
            </button>
          </div>
        </div>
      </div>

      {/* --- MEMORY ALLOCATION DISTRIBUTION BAR (Visible in Split / Hex / Records) --- */}
      {parsedPage && activeSubTab !== 'heatmap' && activeSubTab !== 'tree' && (
        <div className="page-mem-bar-wrapper">
          <div className="page-mem-bar-header">
            <span className="mem-bar-title">PAGE MEMORY DISTRIBUTION (4 KB SLOTTED LAYOUT)</span>
            <div className="mem-bar-legend">
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#8b5cf6' }}></span>
                Header: {parsedPage.memoryDistribution.headerBytes}B
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#06b6d4' }}></span>
                Slot Dir: {parsedPage.memoryDistribution.slotDirBytes}B
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: 'var(--text-muted)' }}></span>
                Free Space: {parsedPage.memoryDistribution.freeBytes.toLocaleString()}B ({((parsedPage.memoryDistribution.freeBytes / 4096) * 100).toFixed(1)}%)
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#10b981' }}></span>
                Payloads: {parsedPage.memoryDistribution.payloadBytes.toLocaleString()}B
              </span>
              {parsedPage.memoryDistribution.fragmentedBytes > 0 && (
                <span className="legend-item">
                  <span className="legend-dot" style={{ background: '#f59e0b' }}></span>
                  Fragmented: {parsedPage.memoryDistribution.fragmentedBytes}B
                </span>
              )}
            </div>
          </div>

          <div className="page-mem-bar-track">
            {memorySegments.map((seg, sIdx) => {
              const widthPct = (seg.size / totalPageSize) * 100;
              return (
                <div
                  key={sIdx}
                  className="page-mem-bar-segment"
                  style={{
                    width: `${widthPct}%`,
                    background: seg.color,
                  }}
                  title={`${seg.name}\nOffset: 0x${seg.start.toString(16).padStart(4, '0')} .. 0x${seg.end.toString(16).padStart(4, '0')}\nSize: ${seg.size} Bytes (${widthPct.toFixed(1)}%)`}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* --- HEADER METRICS SUMMARY CARDS --- */}
      {parsedPage && activeSubTab !== 'heatmap' && activeSubTab !== 'tree' && (
        <div className="page-header-cards-grid">
          {parsedPage.isPage1 ? (
            <>
              <div className="header-metric-card">
                <span className="metric-label">MAGIC IDENTIFIER</span>
                <span className="metric-value font-mono">
                  {parsedPage.header.magic ? `${parsedPage.header.magic}\\0` : 'WEBDB\\0'}
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">TOTAL DATABASE PAGES</span>
                <span className="metric-value">{parsedPage.header.totalPages} pages</span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">FREE PAGE LIST HEAD</span>
                <span className="metric-value">
                  {parsedPage.header.freePageHead === 0
                    ? '0 (None)'
                    : `Page ${parsedPage.header.freePageHead}`}
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">SCHEMA VERSION</span>
                <span className="metric-value">v{parsedPage.header.schemaVersion}</span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">WRITE COUNTER</span>
                <span className="metric-value">{parsedPage.header.changeCounter}</span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">CRC32 CHECKSUM</span>
                <span className="metric-value font-mono">
                  0x{parsedPage.header.checksum?.toString(16).padStart(8, '0')}
                </span>
              </div>
            </>
          ) : parsedPage.header.pageType === 0x0C ? (
            <>
              <div className="header-metric-card">
                <span className="metric-label">COLUMNS IN PAGE</span>
                <span className="metric-value">
                  {parsedPage.columnCatalogDescriptors?.length || 0} columns
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">OWNING TABLE</span>
                <span className="metric-value">
                  {parsedPage.associatedTable?.name || `Table #${parsedPage.header.tableId}`}
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">NEXT CATALOG PAGE</span>
                <span className="metric-value">
                  {parsedPage.header.nextColCatalogPageId ? (
                    <button
                      className="link-btn-highlight"
                      onClick={() => inspectPage(parsedPage.header.nextColCatalogPageId!)}
                    >
                      Page {parsedPage.header.nextColCatalogPageId} &rarr;
                    </button>
                  ) : (
                    '0 (End)'
                  )}
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">METADATA SIZE</span>
                <span className="metric-value">
                  {16 + (parsedPage.columnCatalogDescriptors?.length || 0) * 72} B
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">DESCRIPTOR SIZE</span>
                <span className="metric-value font-mono">72 Bytes / Col</span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">PAGE TYPE</span>
                <span className="metric-value font-mono" style={{ color: '#06b6d4' }}>0x0C (Catalog)</span>
              </div>
            </>
          ) : (
            <>
              <div className="header-metric-card">
                <span className="metric-label">ACTIVE CELL COUNT</span>
                <span className="metric-value">
                  {parsedPage.header.cellCount} {parsedPage.header.cellCount === 1 ? 'cell' : 'cells'}
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">CONTENT OFFSET</span>
                <span className="metric-value font-mono">
                  0x{parsedPage.header.contentOffset?.toString(16).padStart(4, '0')} ({parsedPage.header.contentOffset} / 4096)
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">SIBLING POINTER</span>
                <span className="metric-value">
                  {parsedPage.header.nextPageId === 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>0 (End of chain)</span>
                  ) : (
                    <button
                      className="link-btn-highlight"
                      onClick={() => inspectPage(parsedPage.header.nextPageId!)}
                      title="Inspect next linked page"
                    >
                      Page {parsedPage.header.nextPageId} &rarr;
                    </button>
                  )}
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">CONTIGUOUS FREE</span>
                <span className="metric-value">
                  {parsedPage.memoryDistribution.freeBytes.toLocaleString()} B
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">FRAGMENTED HOLES</span>
                <span className="metric-value">
                  {parsedPage.header.freeBytes} B
                </span>
              </div>
              <div className="header-metric-card">
                <span className="metric-label">CRC32 CHECKSUM</span>
                <span className="metric-value font-mono">
                  0x{parsedPage.header.checksum?.toString(16).padStart(8, '0')}
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* --- ERROR MESSAGE --- */}
      {error && (
        <div className="page-inspector-error-card">
          <strong>Cannot Load Page {selectedPageId}:</strong> {error}
        </div>
      )}

      {/* --- VIEW MODE 1: GITHUB-STYLE HEATMAP GRID VIEW --- */}
      {activeSubTab === 'heatmap' && (
        <div className="page-heatmap-view-container">
          {/* Top Heatmap Overview Statistics */}
          <div className="heatmap-overview-bar">
            <div className="heatmap-stat-item">
              <span className="stat-label">TOTAL ALLOCATED PAGES</span>
              <span className="stat-value">{heatmapStats.totalCount}</span>
            </div>
            <div className="heatmap-stat-item">
              <span className="stat-label">TOTAL STORAGE SPACE</span>
              <span className="stat-value font-mono">{(heatmapStats.totalBytes / 1024).toFixed(1)} KB</span>
            </div>
            <div className="heatmap-stat-item">
              <span className="stat-label">SPACE UTILIZATION</span>
              <span className="stat-value font-mono">{heatmapStats.overallUtilPercent}%</span>
            </div>
            <div className="heatmap-stat-item">
              <span className="stat-label">TABLE DATA PAGES</span>
              <span className="stat-value">{heatmapStats.leafCount}</span>
            </div>
            <div className="heatmap-stat-item">
              <span className="stat-label">FREE PAGES</span>
              <span className="stat-value">{heatmapStats.freeCount}</span>
            </div>
          </div>

          {/* Heatmap & Utilization Legend Ribbon */}
          <div className="heatmap-legend-ribbon">
            <div className="heatmap-legend-group">
              <span className="heatmap-legend-group-title">PAGE TYPE:</span>
              <span className="heatmap-type-chip" style={{ borderColor: 'rgba(139, 92, 246, 0.4)' }}>
                <span className="heatmap-type-dot" style={{ background: '#8b5cf6' }} />
                System
              </span>
              <span className="heatmap-type-chip" style={{ borderColor: 'rgba(16, 185, 129, 0.4)' }}>
                <span className="heatmap-type-dot" style={{ background: '#10b981' }} />
                Table Leaf Data
              </span>
              <span className="heatmap-type-chip" style={{ borderColor: 'rgba(59, 130, 246, 0.4)' }}>
                <span className="heatmap-type-dot" style={{ background: '#3b82f6' }} />
                Table Interior
              </span>
              <span className="heatmap-type-chip" style={{ borderColor: 'rgba(6, 182, 212, 0.4)' }}>
                <span className="heatmap-type-dot" style={{ background: '#06b6d4' }} />
                Column Catalog
              </span>
              <span className="heatmap-type-chip" style={{ borderColor: 'rgba(245, 158, 11, 0.4)' }}>
                <span className="heatmap-type-dot" style={{ background: '#f59e0b' }} />
                Index Node
              </span>
              <span className="heatmap-type-chip" style={{ borderColor: 'rgba(100, 116, 139, 0.4)' }}>
                <span className="heatmap-type-dot" style={{ background: '#64748b' }} />
                Free Page
              </span>
            </div>

            <div className="heatmap-legend-group">
              <span className="heatmap-legend-group-title">UTILIZATION:</span>
              <span className="heatmap-util-pill" style={{ borderColor: 'rgba(16, 185, 129, 0.3)' }}>
                <span className="heatmap-util-swatch" style={{ background: 'rgba(16, 185, 129, 0.15)', borderColor: 'rgba(16, 185, 129, 0.4)' }} />
                15%
              </span>
              <span className="heatmap-util-pill" style={{ borderColor: 'rgba(16, 185, 129, 0.4)' }}>
                <span className="heatmap-util-swatch" style={{ background: 'rgba(16, 185, 129, 0.35)', borderColor: 'rgba(16, 185, 129, 0.6)' }} />
                35%
              </span>
              <span className="heatmap-util-pill" style={{ borderColor: 'rgba(16, 185, 129, 0.5)' }}>
                <span className="heatmap-util-swatch" style={{ background: 'rgba(16, 185, 129, 0.60)', borderColor: 'rgba(16, 185, 129, 0.8)' }} />
                60%
              </span>
              <span className="heatmap-util-pill" style={{ borderColor: 'rgba(16, 185, 129, 0.6)' }}>
                <span className="heatmap-util-swatch" style={{ background: 'rgba(16, 185, 129, 0.85)', borderColor: '#10b981' }} />
                85%
              </span>
              <span className="heatmap-util-pill" style={{ borderColor: 'rgba(16, 185, 129, 0.7)' }}>
                <span className="heatmap-util-swatch" style={{ background: '#10b981', borderColor: '#059669' }} />
                100%
              </span>
            </div>
          </div>

          {/* Main Heatmap Area: Condensed Squares Grid on Left + Detail Side Panel on Right */}
          <div className="heatmap-main-content">
            <div className="heatmap-grid-scroller">
              <div className="heatmap-squares-grid">
                {discoveredPages.map((p) => {
                  const isSelected = p.pageId === selectedPageId;
                  const heatColor = getPageHeatColorByUtilization(p.pageType, p.usagePercent || 0);

                  return (
                    <div
                      key={p.pageId}
                      className={`page-heat-square ${isSelected ? 'selected' : ''}`}
                      style={{
                        backgroundColor: heatColor.fill,
                        borderColor: heatColor.border,
                      }}
                      onClick={() => {
                        setSelectedPageId(p.pageId);
                      }}
                      title={`Page ${p.pageId} • ${p.label}\nType: ${PAGE_TYPE_NAMES[p.pageType] || 'System'}\nUtilization: ${p.usagePercent || 0}%\nUsed: ${p.usedBytes?.toLocaleString()} B\nFree: ${p.freeBytes?.toLocaleString()} B\nCells: ${p.cellCount || 0}`}
                    />
                  );
                })}
              </div>
            </div>

            {/* Right Side Detail Panel for Clicked Page */}
            <div className="heatmap-sidebar-panel">
              <div className="heatmap-sidebar-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                    <h3 className="heatmap-sidebar-title font-mono">
                      Page {selectedPageId}
                    </h3>
                    <span
                      className="heatmap-type-pill"
                      style={{
                        borderColor: getPageTypeRgbColor(activePageSummary.pageType, 0.4),
                        color: getPageTypeRgbColor(activePageSummary.pageType, 1),
                        background: getPageTypeRgbColor(activePageSummary.pageType, 0.1),
                      }}
                    >
                      {PAGE_TYPE_NAMES[activePageSummary.pageType] || 'System Catalog'}
                    </span>
                  </div>
                  <div className="heatmap-sidebar-subtitle">
                    {activePageSummary.label}
                  </div>
                </div>
              </div>

              {/* Usage Progress Card */}
              <div className="heatmap-sidebar-usage-card">
                <div className="usage-card-top">
                  <span className="usage-card-label">PAGE FULLNESS</span>
                  <span className="usage-card-val font-mono">{activePageSummary.usagePercent || 0}%</span>
                </div>
                <div className="usage-mini-track">
                  <div
                    className="usage-mini-fill"
                    style={{
                      width: `${activePageSummary.usagePercent || 0}%`,
                      backgroundColor: getPageTypeRgbColor(activePageSummary.pageType, 1),
                    }}
                  />
                </div>
                <div className="usage-card-breakdown font-mono">
                  <span>Used: {(activePageSummary.usedBytes || 0).toLocaleString()} B</span>
                  <span>Free: {(activePageSummary.freeBytes || 0).toLocaleString()} B</span>
                </div>
              </div>

              {/* Page Metrics Details */}
              <div className="heatmap-sidebar-details-list">
                <div className="sidebar-detail-row">
                  <span className="detail-row-key">OWNING TABLE</span>
                  <span className="detail-row-val font-mono">
                    {activePageSummary.tableName || 'System (Catalog)'}
                  </span>
                </div>
                <div className="sidebar-detail-row">
                  <span className="detail-row-key">PAGE ROLE</span>
                  <span className="detail-row-val" style={{ textTransform: 'capitalize' }}>
                    {activePageSummary.role}
                  </span>
                </div>
                <div className="sidebar-detail-row">
                  <span className="detail-row-key">ACTIVE RECORDS</span>
                  <span className="detail-row-val font-mono">
                    {activePageSummary.cellCount || (parsedPage?.pageId === selectedPageId ? (parsedPage.columnCatalogDescriptors?.length || parsedPage.cells.length) : 0)} entries
                  </span>
                </div>
                {parsedPage && parsedPage.pageId === selectedPageId && (
                  <>
                    <div className="sidebar-detail-row">
                      <span className="detail-row-key">CONTENT OFFSET</span>
                      <span className="detail-row-val font-mono">
                        0x{parsedPage.header.contentOffset?.toString(16).padStart(4, '0') || '1000'}
                      </span>
                    </div>
                    <div className="sidebar-detail-row">
                      <span className="detail-row-key">SIBLING POINTER</span>
                      <span className="detail-row-val font-mono">
                        {parsedPage.header.nextPageId ? `Page ${parsedPage.header.nextPageId}` : '0 (End)'}
                      </span>
                    </div>
                    <div className="sidebar-detail-row">
                      <span className="detail-row-key">CRC32 CHECKSUM</span>
                      <span className="detail-row-val font-mono">
                        0x{parsedPage.header.checksum?.toString(16).padStart(8, '0')}
                      </span>
                    </div>
                  </>
                )}
              </div>

              <div style={{ marginTop: 'auto', paddingTop: '16px' }}>
                <button
                  className="btn btn-sm btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => setActiveSubTab('split')}
                >
                  Inspect in Split View &rarr;
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- VIEW MODE 2: B-TREE INDEX HIERARCHY GRAPHICAL TREE VIEW --- */}
      {activeSubTab === 'tree' && (
        <div className="page-btree-view-container">
          {btreeRoot ? (
            <BTreeGraphView
              rootNode={btreeRoot}
              selectedPageId={selectedPageId}
              onSelectPage={(pageId) => setSelectedPageId(pageId)}
              onInspectPage={(pageId) => {
                setSelectedPageId(pageId);
                setActiveSubTab('split');
              }}
              tables={tables}
            />
          ) : (
            <div className="btree-empty-state">
              <RotateCw size={20} className="spin" style={{ marginBottom: '8px' }} />
              <span>Building B-Tree graphical hierarchy...</span>
            </div>
          )}
        </div>
      )}

      {/* --- VIEW MODE 3: SPLIT, HEX, OR RECORDS VIEW --- */}
      {parsedPage && activeSubTab !== 'heatmap' && activeSubTab !== 'tree' && (
        <div ref={inspectorBodyRef} className={`page-inspector-body-layout view-${activeSubTab}`}>
          {/* LEFT: HEX DUMP VIEWER */}
          {(activeSubTab === 'split' || activeSubTab === 'hex') && (
            <div className="hex-viewer-panel">
              <div className="panel-subtitle-bar">
                <span className="panel-subtitle-title">RAW 4KB HEX DUMP</span>
                {hoveredColumnRange ? (
                  <span className="hex-hover-indicator" style={{ color: '#f59e0b', fontWeight: 700 }}>
                    Column '{hoveredColumnRange.colName}' (0x{hoveredColumnRange.start.toString(16).padStart(4, '0')}..0x{hoveredColumnRange.end.toString(16).padStart(4, '0')}, {hoveredColumnRange.length}B)
                  </span>
                ) : hoveredByteOffset !== null ? (
                  <span className="hex-hover-indicator">
                    Offset: 0x{hoveredByteOffset.toString(16).padStart(4, '0')} ({hoveredByteOffset})
                    {' • '}
                    {getByteCategory(hoveredByteOffset, parsedPage, activeHighlighted, hoveredColumnRange).tooltip}
                  </span>
                ) : null}
              </div>

              <div className="hex-dump-scroller" ref={hexScrollerRef}>
                <table className="hex-dump-table">
                  <thead>
                    <tr>
                      <th className="hex-addr-col">ADDR</th>
                      <th className="hex-bytes-col">
                        00 01 02 03 04 05 06 07 &nbsp; 08 09 0A 0B 0C 0D 0E 0F
                      </th>
                      <th className="hex-ascii-col">ASCII</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hexLines.map((line) => {
                      const isLineInActiveCell =
                        activeHighlighted &&
                        line.offset + 16 > activeHighlighted.offset &&
                        line.offset < activeHighlighted.offset + activeHighlighted.length;

                      return (
                        <tr
                          key={line.offset}
                          id={`hex-line-${line.offset}`}
                          className={`hex-line-row ${isLineInActiveCell ? 'row-has-active-cell' : ''}`}
                        >
                          <td className="hex-addr-cell font-mono">{line.offsetHex}</td>
                          <td className="hex-bytes-cell font-mono">
                            {line.bytes.map((b, bIdx) => {
                              const { category, tooltip } = getByteCategory(
                                b.index,
                                parsedPage,
                                activeHighlighted,
                                hoveredColumnRange
                              );
                              const isHovered = hoveredByteOffset === b.index;
                              return (
                                <React.Fragment key={b.index}>
                                  {bIdx === 8 && <span className="hex-byte-sep">&nbsp;</span>}
                                  <span
                                    className={`hex-byte-item byte-cat-${category} ${isHovered ? 'hovered' : ''}`}
                                    title={tooltip}
                                    onMouseEnter={() => setHoveredByteOffset(b.index)}
                                    onMouseLeave={() => setHoveredByteOffset(null)}
                                  >
                                    {b.hex}
                                  </span>
                                </React.Fragment>
                              );
                            })}
                          </td>
                          <td className="hex-ascii-cell font-mono">
                            {line.bytes.map((b) => {
                              const { category } = getByteCategory(
                                b.index,
                                parsedPage,
                                activeHighlighted,
                                hoveredColumnRange
                              );
                              return (
                                <span
                                  key={b.index}
                                  className={`hex-ascii-char ascii-cat-${category}`}
                                  onMouseEnter={() => setHoveredByteOffset(b.index)}
                                  onMouseLeave={() => setHoveredByteOffset(null)}
                                >
                                  {b.char}
                                </span>
                              );
                            })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SPLITTER IN SPLIT VIEW */}
          {activeSubTab === 'split' && (
            <VerticalSplitter
              currentWidth={recordsPanelWidth}
              onDrag={handleRecordsPanelDrag}
              direction="right"
            />
          )}

          {/* RIGHT: DECODED RECORDS & CATALOG VIEW */}
          {(activeSubTab === 'split' || activeSubTab === 'records') && (
            <div
              className="records-viewer-panel"
              style={activeSubTab === 'split' ? { width: `${recordsPanelWidth}px`, flex: `0 0 ${recordsPanelWidth}px` } : undefined}
            >
              <div className="panel-subtitle-bar">
                <span className="panel-subtitle-title">
                  {parsedPage.isPage1
                    ? `MASTER CATALOG DESCRIPTORS (${parsedPage.header.tables?.length || 0} Tables, ${parsedPage.header.indexes?.length || 0} Indexes)`
                    : parsedPage.header.pageType === 0x0C
                    ? `COLUMN CATALOG DEFINITIONS (${parsedPage.columnCatalogDescriptors?.length || 0} Columns)`
                    : `SLOTTED CELL RECORDS TABLE (${parsedPage.cells.length} Active Records)`}
                </span>
                {hoveredColumnRange ? (
                  <span className="hex-hover-indicator" style={{ color: '#f59e0b' }}>
                    Highlighting column '{hoveredColumnRange.colName}' ({hoveredColumnRange.length}B)
                  </span>
                ) : activeHighlighted ? (
                  <span className="hex-hover-indicator" style={{ color: '#10b981' }}>
                    Highlighting Slot #{activeHighlighted.cellIndex} (Offset 0x{activeHighlighted.offset.toString(16)})
                  </span>
                ) : null}
              </div>

              <div className="records-content-scroller">
                {parsedPage.isPage1 ? (
                  /* PAGE 1: SYSTEM CATALOG DESCRIPTORS */
                  <div className="catalog-tables-container">
                    <h4 className="section-label">Master Table Descriptors</h4>
                    {parsedPage.header.tables && parsedPage.header.tables.length > 0 ? (
                      <table className="results-table">
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>TABLE NAME</th>
                            <th>ROOT PAGE</th>
                            <th>COLUMNS</th>
                            <th>EST. ROWS</th>
                            <th>ACTION</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parsedPage.header.tables.map((t, idx) => (
                            <tr
                              key={t.name}
                              style={{ cursor: 'pointer' }}
                              onClick={() => scrollToHexOffset(100 + idx * 128)}
                              title="Click to autoscroll to 128-byte table descriptor in Hex Dump"
                            >
                              <td className="font-mono">#{t.tableId}</td>
                              <td style={{ fontWeight: 600 }}>{t.name}</td>
                              <td>
                                <button
                                  className="link-btn-highlight"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    inspectPage(t.rootPageId);
                                  }}
                                  title={`Inspect Page ${t.rootPageId}`}
                                >
                                  Page {t.rootPageId} &rarr;
                                </button>
                              </td>
                              <td>{t.columnCount} cols</td>
                              <td className="font-mono">{t.rowCountEstimate.toLocaleString()}</td>
                              <td>
                                <button
                                  className="btn btn-sm"
                                  style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    inspectPage(t.rootPageId);
                                  }}
                                >
                                  Inspect Root
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="empty-subtext">No tables defined in database catalog yet.</div>
                    )}

                    {parsedPage.header.indexes && parsedPage.header.indexes.length > 0 && (
                      <>
                        <h4 className="section-label" style={{ marginTop: '20px' }}>
                          B-Tree Index Descriptors
                        </h4>
                        <table className="results-table">
                          <thead>
                            <tr>
                              <th>ID</th>
                              <th>INDEX NAME</th>
                              <th>TABLE ID</th>
                              <th>ROOT PAGE</th>
                              <th>INDEXED COLS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {parsedPage.header.indexes.map((idx, i) => (
                              <tr
                                key={idx.name}
                                style={{ cursor: 'pointer' }}
                                onClick={() => scrollToHexOffset(2148 + i * 128)}
                                title="Click to autoscroll to 128-byte index descriptor in Hex Dump"
                              >
                                <td className="font-mono">#{idx.indexId}</td>
                                <td style={{ fontWeight: 600 }}>{idx.name}</td>
                                <td>Table #{idx.tableId}</td>
                                <td>
                                  <button
                                    className="link-btn-highlight"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      inspectPage(idx.rootPageId);
                                    }}
                                  >
                                    Page {idx.rootPageId} &rarr;
                                  </button>
                                </td>
                                <td>{idx.indexedColCount}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                ) : parsedPage.header.pageType === 0x0C ? (
                  /* PAGE TYPE 0x0C: COLUMN CATALOG DEFINITIONS TABLE */
                  <div className="catalog-columns-container">
                    {parsedPage.columnCatalogDescriptors && parsedPage.columnCatalogDescriptors.length > 0 ? (
                      <table className="results-table catalog-columns-table">
                        <thead>
                          <tr>
                            <th style={{ width: '45px', textAlign: 'center' }}>COL #</th>
                            <th style={{ width: '130px' }}>NAME</th>
                            <th style={{ width: '95px' }}>DATA TYPE</th>
                            <th style={{ width: '170px' }}>CONSTRAINTS</th>
                            <th style={{ width: '85px' }}>ROW OFFSET</th>
                            <th>72-BYTE RAW METADATA PREVIEW</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parsedPage.columnCatalogDescriptors.map((col) => {
                            const isRowActive = activeHighlighted?.cellIndex === col.columnIndex;
                            return (
                              <tr
                                key={col.columnIndex}
                                className={`slot-table-row ${isRowActive ? 'active-slot-row' : ''}`}
                                onMouseEnter={() => {
                                  setHighlightedCell({
                                    cellIndex: col.columnIndex,
                                    offset: col.rawOffset,
                                    length: 72,
                                  });
                                }}
                                onMouseLeave={() => setHighlightedCell(null)}
                                onClick={() => {
                                  setPinnedCellIndex(pinnedCellIndex === col.columnIndex ? null : col.columnIndex);
                                  scrollToHexOffset(col.rawOffset);
                                }}
                                title="Hover to highlight the 72 raw bytes in Hex Viewer. Click to pin & autoscroll."
                              >
                                <td className="slot-col-idx font-mono" style={{ textAlign: 'center' }}>
                                  #{col.columnIndex}
                                </td>
                                <td style={{ fontWeight: 600, color: 'var(--text)' }}>
                                  {col.name}
                                </td>
                                <td>
                                  <span className="column-type-badge font-mono">
                                    {col.typeName} ({col.type})
                                  </span>
                                </td>
                                <td>
                                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                    {col.isPrimaryKey && (
                                      <span className="constraint-badge pk">PRIMARY KEY</span>
                                    )}
                                    {col.isNotNull && (
                                      <span className="constraint-badge not-null">NOT NULL</span>
                                    )}
                                    {col.isAutoInc && (
                                      <span className="constraint-badge auto-inc">AUTO INCREMENT</span>
                                    )}
                                    {!col.isPrimaryKey && !col.isNotNull && !col.isAutoInc && (
                                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>None</span>
                                    )}
                                  </div>
                                </td>
                                <td className="font-mono slot-col-offset">
                                  +{col.colOffset} B
                                </td>
                                <td className="font-mono raw-bytes-preview" style={{ fontSize: '0.67rem', color: 'var(--text-secondary)' }}>
                                  {col.rawBytesHex}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <div className="empty-subtext">No column descriptors found on this catalog page.</div>
                    )}
                  </div>
                ) : (
                  /* PAGES 2+: SLOTTED CELL RECORDS RENDERED AS A HIGH-DENSITY TABLE */
                  <div className="cells-table-wrapper">
                    {parsedPage.cells.length === 0 ? (
                      <div className="empty-cells-box">
                        <Binary size={24} style={{ opacity: 0.4, marginBottom: '8px' }} />
                        <div>No active cell records stored on this page yet.</div>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                          Content offset is at 0x{parsedPage.header.contentOffset?.toString(16).padStart(4, '0')} (Empty page).
                        </div>
                      </div>
                    ) : (
                      <table className="results-table slots-data-table">
                        <thead>
                          <tr>
                            <th style={{ width: '45px', textAlign: 'center' }}>SLOT</th>
                            <th style={{ width: '85px' }}>OFFSET</th>
                            <th style={{ width: '65px' }}>SIZE</th>
                            {schemaColumns.length > 0 ? (
                              schemaColumns.map((col) => (
                                <th key={col.name}>
                                  {col.name}
                                </th>
                              ))
                            ) : parsedPage.header.pageType === 0x05 ? (
                              <>
                                <th>CHILD SUBTREE</th>
                                <th>SEPARATOR ROWID</th>
                              </>
                            ) : (
                              <th>DECODED RECORD DATA</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {parsedPage.cells.map((cell) => {
                            const isPinned = pinnedCellIndex === cell.cellIndex;
                            const isHovered = highlightedCell?.cellIndex === cell.cellIndex;
                            const isRowActive = isPinned || isHovered;

                            return (
                              <tr
                                key={cell.cellIndex}
                                className={`slot-table-row ${isRowActive ? 'active-slot-row' : ''}`}
                                onMouseEnter={() => setHighlightedCell(cell)}
                                onMouseLeave={() => setHighlightedCell(null)}
                                onClick={() => {
                                  setPinnedCellIndex(isPinned ? null : cell.cellIndex);
                                  scrollToHexOffset(cell.offset);
                                }}
                                title="Hover to highlight row bytes. Click to pin & autoscroll to hex bytes."
                              >
                                {/* 1. Slot Number */}
                                <td className="slot-col-idx font-mono" style={{ textAlign: 'center' }}>
                                  #{cell.cellIndex}
                                </td>

                                {/* 2. Offset */}
                                <td className="slot-col-offset font-mono">
                                  0x{cell.offset.toString(16).padStart(4, '0')}
                                </td>

                                {/* 3. Size */}
                                <td className="slot-col-size font-mono">
                                  {cell.length} B
                                </td>

                                {/* 4. Decoded Columns with Cell-Level Hex Highlighting */}
                                {schemaColumns.length > 0 ? (
                                  schemaColumns.map((col) => {
                                    const val = cell.data ? cell.data[col.name] : undefined;
                                    const colRange = cell.columnRanges ? cell.columnRanges[col.name] : undefined;
                                    const isCellHovered =
                                      hoveredColumnRange?.colName === col.name &&
                                      activeHighlighted?.cellIndex === cell.cellIndex;

                                    return (
                                      <td
                                        key={col.name}
                                        className={`slot-col-val font-mono ${isCellHovered ? 'cell-column-hovered' : ''}`}
                                        onMouseEnter={() => {
                                          if (colRange) {
                                            setHoveredColumnRange(colRange);
                                          }
                                        }}
                                        onMouseLeave={() => {
                                          setHoveredColumnRange(null);
                                        }}
                                        onClick={(e) => {
                                          if (colRange && !colRange.isNull) {
                                            e.stopPropagation();
                                            setPinnedCellIndex(cell.cellIndex);
                                            setHoveredColumnRange(colRange);
                                            scrollToHexOffset(colRange.start);
                                          }
                                        }}
                                        title={
                                          colRange && !colRange.isNull
                                            ? `Column '${col.name}': 0x${colRange.start.toString(16)}..0x${colRange.end.toString(16)} (${colRange.length}B). Click to focus & autoscroll.`
                                            : undefined
                                        }
                                      >
                                        {val === null || val === undefined ? (
                                          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                            null
                                          </span>
                                        ) : typeof val === 'object' ? (
                                          JSON.stringify(val)
                                        ) : (
                                          String(val)
                                        )}
                                      </td>
                                    );
                                  })
                                ) : cell.childPageId !== undefined ? (
                                  <>
                                    <td>
                                      <button
                                        className="link-btn-highlight"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          inspectPage(cell.childPageId!);
                                        }}
                                      >
                                        Page {cell.childPageId} &rarr;
                                      </button>
                                    </td>
                                    <td className="font-mono">{cell.separatorRowId}</td>
                                  </>
                                ) : (
                                  <td className="slot-col-val font-mono">
                                    {cell.data ? (
                                      JSON.stringify(cell.data)
                                    ) : cell.rawHex ? (
                                      <span>{cell.rawHex}</span>
                                    ) : (
                                      <span style={{ color: 'var(--text-muted)' }}>-</span>
                                    )}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
