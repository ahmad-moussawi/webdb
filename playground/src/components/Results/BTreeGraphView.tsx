import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
  BTreeNode,
  getPageTypeRgbColor,
  PAGE_TYPE_NAMES,
} from '../../utils/pageInspector';
import { TableMeta } from '../../types/studio';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  RotateCcw,
  ExternalLink,
  Table as TableIcon,
  Layers,
  ArrowRight,
  Filter,
  ListTree,
  Network,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';

interface BTreeGraphViewProps {
  rootNode: BTreeNode;
  selectedPageId: number;
  onSelectPage: (pageId: number) => void;
  onInspectPage: (pageId: number) => void;
  tables: TableMeta[];
}

interface LayoutNode {
  id: string;
  data: BTreeNode;
  x: number;
  y: number;
  width: number;
  height: number;
  subtreeWidth: number;
  depth: number;
  parent?: LayoutNode;
  children: LayoutNode[];
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 108;
const HORIZONTAL_GAP = 40;
const VERTICAL_GAP = 85;

export const BTreeGraphView: React.FC<BTreeGraphViewProps> = ({
  rootNode,
  selectedPageId,
  onSelectPage,
  onInspectPage,
  tables,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // View settings
  const [viewMode, setViewMode] = useState<'graph' | 'outline'>('graph');
  const [selectedTableFilter, setSelectedTableFilter] = useState<string>('all');
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 50, y: 40 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Outline view expansion state
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(['node-1']));

  // Filter root tree if a specific table is selected
  const activeTreeRoot = useMemo<BTreeNode>(() => {
    if (selectedTableFilter === 'all') return rootNode;

    const matchedChild = rootNode.children.find(
      (c) => c.tableName?.toLowerCase() === selectedTableFilter.toLowerCase()
    );

    if (matchedChild) {
      return {
        ...matchedChild,
        label: `${matchedChild.label} (Isolated View)`,
      };
    }
    return rootNode;
  }, [rootNode, selectedTableFilter]);

  // Compute 2D node layout
  const layout = useMemo(() => {
    let nodeIdCounter = 0;

    function buildLayoutTree(
      node: BTreeNode,
      depth: number = 0,
      parent?: LayoutNode
    ): LayoutNode {
      const id = `node-${node.pageId}-${nodeIdCounter++}`;
      const layoutNode: LayoutNode = {
        id,
        data: node,
        x: 0,
        y: 0,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        subtreeWidth: NODE_WIDTH,
        depth,
        parent,
        children: [],
      };

      layoutNode.children = (node.children || []).map((c) =>
        buildLayoutTree(c, depth + 1, layoutNode)
      );

      return layoutNode;
    }

    const layoutRoot = buildLayoutTree(activeTreeRoot);

    // Pass 1: compute subtree widths bottom-up
    function computeSubtreeWidth(node: LayoutNode): number {
      if (node.children.length === 0) {
        node.subtreeWidth = node.width;
        return node.subtreeWidth;
      }

      let totalChildWidth = 0;
      for (let i = 0; i < node.children.length; i++) {
        totalChildWidth += computeSubtreeWidth(node.children[i]);
        if (i > 0) totalChildWidth += HORIZONTAL_GAP;
      }

      node.subtreeWidth = Math.max(node.width, totalChildWidth);
      return node.subtreeWidth;
    }

    computeSubtreeWidth(layoutRoot);

    // Pass 2: assign (x, y) coordinates top-down
    function assignPositions(node: LayoutNode, left: number, top: number) {
      node.x = left + (node.subtreeWidth - node.width) / 2;
      node.y = top;

      const totalChildrenSpan = node.children.reduce(
        (acc, c, idx) => acc + c.subtreeWidth + (idx > 0 ? HORIZONTAL_GAP : 0),
        0
      );

      let currentLeft = left;
      if (totalChildrenSpan < node.subtreeWidth) {
        currentLeft = left + (node.subtreeWidth - totalChildrenSpan) / 2;
      }

      for (const child of node.children) {
        assignPositions(child, currentLeft, top + node.height + VERTICAL_GAP);
        currentLeft += child.subtreeWidth + HORIZONTAL_GAP;
      }
    }

    assignPositions(layoutRoot, 40, 40);

    // Flatten all nodes and collect connector edges
    const allNodes: LayoutNode[] = [];
    const allEdges: Array<{
      id: string;
      source: LayoutNode;
      target: LayoutNode;
      label?: string;
      isSibling?: boolean;
    }> = [];

    function traverse(node: LayoutNode) {
      allNodes.push(node);
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        allEdges.push({
          id: `edge-${node.id}->${child.id}`,
          source: node,
          target: child,
          label: child.data.keysSummary,
          isSibling: child.data.isSiblingChain,
        });
        traverse(child);
      }
    }

    traverse(layoutRoot);

    // Calculate bounding box
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const n of allNodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x + n.width);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y + n.height);
    }

    const bboxWidth = Math.max(maxX - minX, 100);
    const bboxHeight = Math.max(maxY - minY, 100);

    return {
      root: layoutRoot,
      nodes: allNodes,
      edges: allEdges,
      bbox: { minX, maxX, minY, maxY, width: bboxWidth, height: bboxHeight },
    };
  }, [activeTreeRoot]);

  // Center tree on initial render or table filter change
  const handleFitView = useCallback(() => {
    if (!containerRef.current || !layout) return;
    const { clientWidth, clientHeight } = containerRef.current;
    if (clientWidth <= 0 || clientHeight <= 0) return;

    const padding = 60;
    const availableWidth = clientWidth - padding * 2;
    const availableHeight = clientHeight - padding * 2;

    const scaleX = availableWidth / layout.bbox.width;
    const scaleY = availableHeight / layout.bbox.height;
    const newZoom = Math.max(0.4, Math.min(1.2, Math.min(scaleX, scaleY)));

    const newPanX = (clientWidth - layout.bbox.width * newZoom) / 2 - layout.bbox.minX * newZoom;
    const newPanY = (clientHeight - layout.bbox.height * newZoom) / 2 - layout.bbox.minY * newZoom;

    setZoom(newZoom);
    setPan({ x: Math.max(20, newPanX), y: Math.max(20, newPanY) });
  }, [layout]);

  useEffect(() => {
    handleFitView();
  }, [selectedTableFilter, handleFitView]);

  // Mouse pan handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    // Only drag on left click on canvas background (not inside buttons or cards)
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.btree-graph-node-card') || target.closest('button') || target.closest('select')) {
      return;
    }
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Attach non-passive wheel listener to prevent browser zoom and scroll propagation
  useEffect(() => {
    const container = containerRef.current;
    if (!container || viewMode !== 'graph') return;

    const onWheelNative = (e: WheelEvent) => {
      // Completely prevent browser window zoom and page scroll
      e.preventDefault();
      e.stopPropagation();

      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      setZoom((z) => Math.min(2.5, Math.max(0.3, Number((z * zoomFactor).toFixed(3)))));
    };

    container.addEventListener('wheel', onWheelNative, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheelNative);
    };
  }, [viewMode]);

  // Toggle tree node in Outline View
  const toggleOutlineNode = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderOutlineNode = (node: BTreeNode, pathKey: string, depth: number = 0) => {
    const isExpanded = expandedNodes.has(pathKey);
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = node.pageId === selectedPageId;
    const typeColor = getPageTypeRgbColor(node.pageType, 1);

    return (
      <div key={pathKey} className="btree-node-wrapper" style={{ marginLeft: depth > 0 ? '20px' : '0' }}>
        <div className={`btree-node-card ${isSelected ? 'selected' : ''}`}>
          <div className="btree-node-left">
            {hasChildren ? (
              <button
                className="btree-toggle-btn"
                onClick={() => toggleOutlineNode(pathKey)}
                title={isExpanded ? 'Collapse' : 'Expand'}
              >
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : (
              <span className="btree-toggle-placeholder" />
            )}

            <span
              className="btree-page-badge font-mono"
              style={{
                backgroundColor: getPageTypeRgbColor(node.pageType, 0.15),
                borderColor: getPageTypeRgbColor(node.pageType, 0.5),
                color: typeColor,
              }}
            >
              Page {node.pageId}
            </span>

            <div className="btree-node-info">
              <span className="btree-node-label">{node.label}</span>
              <span
                className="btree-type-tag"
                style={{
                  color: typeColor,
                  borderColor: getPageTypeRgbColor(node.pageType, 0.3),
                }}
              >
                {node.pageTypeName}
              </span>
              {node.keysSummary && (
                <span className="btree-keys-badge font-mono">{node.keysSummary}</span>
              )}
              {node.isSiblingChain && (
                <span className="btree-sibling-badge">
                  <ArrowRight size={10} style={{ marginRight: '3px' }} />
                  Linked Sibling
                </span>
              )}
            </div>
          </div>

          <div className="btree-node-right">
            {node.cellCount !== undefined && (
              <span className="btree-meta-stat font-mono">
                {node.cellCount} {node.cellCount === 1 ? 'record' : 'records'}
              </span>
            )}
            <button
              className="btn btn-sm btree-inspect-btn"
              onClick={() => onInspectPage(node.pageId)}
            >
              Inspect <ExternalLink size={10} style={{ marginLeft: '4px' }} />
            </button>
          </div>
        </div>

        {hasChildren && isExpanded && (
          <div className="btree-children-container">
            {node.children.map((child, cIdx) =>
              renderOutlineNode(child, `${pathKey}-${child.pageId}-${cIdx}`, depth + 1)
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="btree-graph-view-container">
      {/* Top Toolbar */}
      <div className="btree-graph-toolbar">
        <div className="btree-graph-filter-group">
          <div className="btree-table-select-wrapper">
            <Filter size={12} className="toolbar-icon-muted" />
            <span className="toolbar-label">FOCUS TABLE:</span>
            <select
              className="btree-table-select"
              value={selectedTableFilter}
              onChange={(e) => setSelectedTableFilter(e.target.value)}
            >
              <option value="all">Full Database Hierarchy</option>
              {tables.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} (B-Tree Root: Page {t.rootPageId})
                </option>
              ))}
            </select>
          </div>

          <span className="toolbar-separator" />

          {/* Mode Switcher */}
          <div className="btree-mode-switch">
            <button
              className={`mode-btn ${viewMode === 'graph' ? 'active' : ''}`}
              onClick={() => setViewMode('graph')}
              title="Graphical Tree Diagram with visual branches"
            >
              <Network size={11} style={{ marginRight: '4px' }} />
              DIAGRAM
            </button>
            <button
              className={`mode-btn ${viewMode === 'outline' ? 'active' : ''}`}
              onClick={() => setViewMode('outline')}
              title="Indented List Outline View"
            >
              <ListTree size={11} style={{ marginRight: '4px' }} />
              OUTLINE
            </button>
          </div>
        </div>

        {/* Zoom & Canvas Actions (Visible in Graph Mode) */}
        {viewMode === 'graph' && (
          <div className="btree-graph-zoom-group">
            <span className="zoom-level-text font-mono">
              {Math.round(zoom * 100)}%
            </span>
            <button
              className="zoom-btn"
              title="Zoom In"
              onClick={() => setZoom((z) => Math.min(2.5, Number((z + 0.15).toFixed(2))))}
            >
              <ZoomIn size={13} />
            </button>
            <button
              className="zoom-btn"
              title="Zoom Out"
              onClick={() => setZoom((z) => Math.max(0.3, Number((z - 0.15).toFixed(2))))}
            >
              <ZoomOut size={13} />
            </button>
            <button
              className="zoom-btn"
              title="Reset Zoom to 100%"
              onClick={() => setZoom(1)}
            >
              <RotateCcw size={12} />
            </button>
            <button
              className="zoom-btn fit-btn"
              title="Fit diagram to viewport"
              onClick={handleFitView}
            >
              <Maximize2 size={12} style={{ marginRight: '3px' }} />
              Fit
            </button>
          </div>
        )}
      </div>

      {/* Main View Area */}
      {viewMode === 'outline' ? (
        <div className="btree-outline-scroller">
          {renderOutlineNode(activeTreeRoot, 'root-node', 0)}
        </div>
      ) : (
        /* 2D GRAPHICAL CANVAS */
        <div
          ref={containerRef}
          className={`btree-canvas-viewport ${isDragging ? 'is-dragging' : ''}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Zoom/Pan Transformed Layer */}
          <div
            className="btree-canvas-transformed-layer"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
            }}
          >
            {/* SVG Connector Lines Behind Cards */}
            <svg
              className="btree-connections-svg"
              style={{
                width: layout.bbox.maxX + 150,
                height: layout.bbox.maxY + 150,
              }}
            >
              <defs>
                <marker
                  id="btree-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--text-muted)" opacity="0.8" />
                </marker>
                <marker
                  id="btree-sibling-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#06b6d4" />
                </marker>
              </defs>

              {/* Render connector curves */}
              {layout.edges.map((edge) => {
                const startX = edge.source.x + edge.source.width / 2;
                const startY = edge.source.y + edge.source.height;
                const endX = edge.target.x + edge.target.width / 2;
                const endY = edge.target.y;

                const midY = (startY + endY) / 2;
                const pathD = `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
                const targetColor = getPageTypeRgbColor(edge.target.data.pageType, 0.6);

                return (
                  <g key={edge.id} className="btree-edge-group">
                    <path
                      d={pathD}
                      fill="none"
                      stroke={targetColor}
                      strokeWidth="2"
                      strokeDasharray={edge.isSibling ? '4,4' : undefined}
                      markerEnd="url(#btree-arrow)"
                    />
                    {edge.label && (
                      <g transform={`translate(${(startX + endX) / 2}, ${midY})`}>
                        <rect
                          x={-42}
                          y={-10}
                          width={84}
                          height={20}
                          rx={4}
                          fill="var(--bg-surface)"
                          stroke="var(--card-border)"
                          strokeWidth="1"
                        />
                        <text
                          textAnchor="middle"
                          dominantBaseline="central"
                          fill="#f59e0b"
                          fontSize="10"
                          fontFamily="monospace"
                          fontWeight="700"
                        >
                          {edge.label}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* Visual Node Cards */}
            {layout.nodes.map((node) => {
              const isSelected = node.data.pageId === selectedPageId;
              const typeColor = getPageTypeRgbColor(node.data.pageType, 1);
              const utilPct = node.data.usagePercent ?? 0;

              return (
                <div
                  key={node.id}
                  className={`btree-graph-node-card ${isSelected ? 'selected' : ''}`}
                  style={{
                    left: `${node.x}px`,
                    top: `${node.y}px`,
                    width: `${node.width}px`,
                    height: `${node.height}px`,
                    borderColor: isSelected ? 'var(--accent)' : getPageTypeRgbColor(node.data.pageType, 0.35),
                  }}
                  onClick={() => onSelectPage(node.data.pageId)}
                >
                  {/* Top Type Stripe */}
                  <div
                    className="node-card-stripe"
                    style={{ backgroundColor: typeColor }}
                  />

                  {/* Header: Page ID + Role Badge */}
                  <div className="node-card-header">
                    <span
                      className="node-page-pill font-mono"
                      style={{
                        color: typeColor,
                        backgroundColor: getPageTypeRgbColor(node.data.pageType, 0.12),
                        borderColor: getPageTypeRgbColor(node.data.pageType, 0.4),
                      }}
                    >
                      Page {node.data.pageId}
                    </span>
                    <span className="node-type-name" title={node.data.pageTypeName}>
                      {node.data.pageTypeName}
                    </span>
                  </div>

                  {/* Title / Description */}
                  <div className="node-card-title" title={node.data.label}>
                    {node.data.label}
                  </div>

                  {/* Footer / Stats & Action */}
                  <div className="node-card-footer">
                    <div className="node-card-stats font-mono">
                      {node.data.cellCount !== undefined ? (
                        <span>{node.data.cellCount} recs</span>
                      ) : (
                        <span>-</span>
                      )}
                      <span>•</span>
                      <span>{utilPct}% used</span>
                    </div>

                    <button
                      className="node-inspect-btn"
                      title="Inspect raw page bytes and records"
                      onClick={(e) => {
                        e.stopPropagation();
                        onInspectPage(node.data.pageId);
                      }}
                    >
                      Inspect <ExternalLink size={10} style={{ marginLeft: '3px' }} />
                    </button>
                  </div>

                  {/* Micro Utilization Bar at bottom */}
                  <div className="node-card-util-bar">
                    <div
                      className="node-card-util-fill"
                      style={{
                        width: `${utilPct}%`,
                        backgroundColor: typeColor,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Graphical Tree Legend Overlay */}
          <div className="btree-graph-legend">
            <span className="legend-title">B-TREE PAGE ROLES:</span>
            <div className="legend-items">
              <span className="legend-pill" style={{ color: '#8b5cf6', borderColor: '#8b5cf6' }}>
                System (0x01)
              </span>
              <span className="legend-pill" style={{ color: '#3b82f6', borderColor: '#3b82f6' }}>
                Interior (0x05)
              </span>
              <span className="legend-pill" style={{ color: '#10b981', borderColor: '#10b981' }}>
                Leaf Data (0x0D)
              </span>
              <span className="legend-pill" style={{ color: '#06b6d4', borderColor: '#06b6d4' }}>
                Catalog (0x0C)
              </span>
              <span className="legend-pill" style={{ color: '#f59e0b', borderColor: '#f59e0b' }}>
                Index (0x0A)
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
