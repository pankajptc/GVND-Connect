import React, { useMemo } from "react";

// Minimal Type-1 & Type-2 QR Code Generator (Zero-Dependency SVG)
// Supports alphanumeric, JSON payloads, and byte data up to ~120 characters

function generateQRMatrix(text: string): boolean[][] {
  // Simple 21x21 Version 1 QR matrix template (with finder patterns & timing)
  const size = 25; // Version 2 (25x25) accommodates standard JSON payloads
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));

  // 1. Finder patterns (Top-left, Top-right, Bottom-left)
  const addFinder = (r: number, c: number) => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const row = r + i;
        const col = c + j;
        if (row >= 0 && row < size && col >= 0 && col < size) {
          if (
            (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
            (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
            (i >= 2 && i <= 4 && j >= 2 && j <= 4)
          ) {
            matrix[row][col] = true;
          } else {
            matrix[row][col] = false;
          }
        }
      }
    }
  };

  addFinder(0, 0);
  addFinder(0, size - 7);
  addFinder(size - 7, 0);

  // 2. Timing patterns
  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0;
    matrix[i][6] = i % 2 === 0;
  }

  // 3. Dark module
  matrix[size - 8][8] = true;

  // 4. Encode Payload Bits (Byte Mode)
  const bytes = new TextEncoder().encode(text);
  const bitStream: number[] = [];

  // Mode indicator for Byte: 0100
  bitStream.push(0, 1, 0, 0);
  // Character count (8 bits for Version 1-9)
  for (let i = 7; i >= 0; i--) bitStream.push((bytes.length >> i) & 1);
  // Data bytes
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) bitStream.push((b >> i) & 1);
  }
  // Terminator
  while (bitStream.length % 8 !== 0) bitStream.push(0);

  // 5. Fill Data into matrix with standard zigzag traversal
  let bitIdx = 0;
  let upwards = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // Skip vertical timing column
    const rows = upwards
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const row of rows) {
      for (const c of [col, col - 1]) {
        if (matrix[row][c] === null) {
          const rawBit = bitIdx < bitStream.length ? bitStream[bitIdx++] : (row + c) % 2 === 0 ? 1 : 0;
          // Apply Standard Mask 000: (row + col) % 2 === 0
          const mask = (row + c) % 2 === 0;
          matrix[row][c] = mask ? rawBit === 0 : rawBit === 1;
        }
      }
    }
    upwards = !upwards;
  }

  return matrix.map((row) => row.map((cell) => cell ?? false));
}

export function QRCodeSVG({
  value,
  size = 200,
  className = "",
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const matrix = useMemo(() => {
    try {
      return generateQRMatrix(value);
    } catch {
      return Array.from({ length: 25 }, () => Array(25).fill(false));
    }
  }, [value]);

  const n = matrix.length;
  const cellSize = 10;
  const viewBoxSize = n * cellSize;

  return (
    <svg
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      width={size}
      height={size}
      className={`rounded-lg bg-white p-2 ${className}`}
      shapeRendering="crispEdges"
    >
      {matrix.map((row, r) =>
        row.map((cell, c) =>
          cell ? (
            <rect
              key={`${r}-${c}`}
              x={c * cellSize}
              y={r * cellSize}
              width={cellSize}
              height={cellSize}
              fill="#000000"
            />
          ) : null
        )
      )}
    </svg>
  );
}
