import React, { useState, useEffect, useRef } from 'react';

interface VerticalSplitterProps {
  currentWidth: number;
  onDrag: (width: number) => void;
  direction?: 'left' | 'right';
}

export const VerticalSplitter: React.FC<VerticalSplitterProps> = ({
  currentWidth,
  onDrag,
  direction = 'left',
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(currentWidth);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startXRef.current;
      const newWidth =
        direction === 'left'
          ? startWidthRef.current + deltaX
          : startWidthRef.current - deltaX;
      onDragRef.current(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, direction]);

  return (
    <div
      className={`splitter-vertical ${isDragging ? 'resizing' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        startXRef.current = e.clientX;
        startWidthRef.current = currentWidth;
        setIsDragging(true);
      }}
      title="Drag to resize panel"
    />
  );
};

interface HorizontalSplitterProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  currentPct: number;
  onDrag: (pct: number) => void;
}

export const HorizontalSplitter: React.FC<HorizontalSplitterProps> = ({
  containerRef,
  currentPct,
  onDrag,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef<number>(0);
  const startPctRef = useRef<number>(currentPct);
  const containerHeightRef = useRef<number>(500);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - startYRef.current;
      const height = containerHeightRef.current || 500;
      const deltaPct = (deltaY / height) * 100;
      onDragRef.current(startPctRef.current + deltaPct);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  return (
    <div
      className={`splitter-horizontal ${isDragging ? 'resizing' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        startYRef.current = e.clientY;
        startPctRef.current = currentPct;
        if (containerRef.current) {
          containerHeightRef.current = containerRef.current.clientHeight;
        }
        setIsDragging(true);
      }}
      title="Drag to resize results height"
    />
  );
};
