import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DrawingCanvas } from '../../src/components/DrawingCanvas'
import type { Stroke } from '../../src/features/room/types'

function createMockCanvasContext(initialWidth = 300, initialHeight = 220) {
  let width = initialWidth
  let height = initialHeight
  let pixelData = new Uint8ClampedArray(width * height * 4).fill(255) // white background
  let currentFillStyle = '#ffffff'
  let currentStrokeStyle = '#0f172a'
  let currentLineWidth = 1
  let pathSegments: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
  let currentPathPoint: { x: number; y: number } | null = null

  const parseColor = (col: string): [number, number, number, number] => {
    if (col === '#ffffff') return [255, 255, 255, 255]
    if (col === '#0f172a') return [15, 23, 42, 255]
    if (col === '#f43f5e') return [244, 63, 94, 255]
    if (col === '#3b82f6') return [59, 130, 246, 255]
    if (col === '#10b981') return [16, 185, 129, 255]
    return [0, 0, 0, 255]
  }

  const drawLine = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: [number, number, number, number],
    lineWidth: number
  ) => {
    x0 = Math.round(x0)
    y0 = Math.round(y0)
    x1 = Math.round(x1)
    y1 = Math.round(y1)
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    const halfWidth = Math.floor(Math.max(1, lineWidth) / 2)

    while (true) {
      for (let ox = -halfWidth; ox <= halfWidth; ox++) {
        for (let oy = -halfWidth; oy <= halfWidth; oy++) {
          const px = x0 + ox
          const py = y0 + oy
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const idx = (py * width + px) * 4
            pixelData[idx] = color[0]
            pixelData[idx + 1] = color[1]
            pixelData[idx + 2] = color[2]
            pixelData[idx + 3] = color[3]
          }
        }
      }
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        x0 += sx
      }
      if (e2 < dx) {
        err += dx
        y0 += sy
      }
    }
  }

  const canvasObj = {
    get width() {
      return width
    },
    set width(w: number) {
      if (w !== width) {
        width = w
        pixelData = new Uint8ClampedArray(width * height * 4).fill(255)
      }
    },
    get height() {
      return height
    },
    set height(h: number) {
      if (h !== height) {
        height = h
        pixelData = new Uint8ClampedArray(width * height * 4).fill(255)
      }
    },
  }

  const ctx = {
    canvas: canvasObj,
    get fillStyle() {
      return currentFillStyle
    },
    set fillStyle(val: string) {
      currentFillStyle = val
    },
    get strokeStyle() {
      return currentStrokeStyle
    },
    set strokeStyle(val: string) {
      currentStrokeStyle = val
    },
    get lineWidth() {
      return currentLineWidth
    },
    set lineWidth(val: number) {
      currentLineWidth = val
    },
    lineCap: 'round',
    lineJoin: 'round',
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      const color = parseColor(currentFillStyle)
      const startX = Math.max(0, Math.round(x))
      const endX = Math.min(width, Math.round(x + w))
      const startY = Math.max(0, Math.round(y))
      const endY = Math.min(height, Math.round(y + h))
      for (let cy = startY; cy < endY; cy++) {
        for (let cx = startX; cx < endX; cx++) {
          const idx = (cy * width + cx) * 4
          pixelData[idx] = color[0]
          pixelData[idx + 1] = color[1]
          pixelData[idx + 2] = color[2]
          pixelData[idx + 3] = color[3]
        }
      }
    }),
    beginPath: vi.fn(() => {
      pathSegments = []
      currentPathPoint = null
    }),
    moveTo: vi.fn((x: number, y: number) => {
      currentPathPoint = { x, y }
    }),
    lineTo: vi.fn((x: number, y: number) => {
      if (currentPathPoint) {
        pathSegments.push({ x0: currentPathPoint.x, y0: currentPathPoint.y, x1: x, y1: y })
      }
      currentPathPoint = { x, y }
    }),
    stroke: vi.fn(() => {
      const color = parseColor(currentStrokeStyle)
      for (const seg of pathSegments) {
        drawLine(seg.x0, seg.y0, seg.x1, seg.y1, color, currentLineWidth)
      }
    }),
    arc: vi.fn((x: number, y: number, _radius: number) => {
      currentPathPoint = { x, y }
    }),
    fill: vi.fn(() => {
      if (currentPathPoint) {
        const color = parseColor(currentFillStyle)
        const cx = Math.round(currentPathPoint.x)
        const cy = Math.round(currentPathPoint.y)
        const idx = (cy * width + cx) * 4
        if (cx >= 0 && cx < width && cy >= 0 && cy < height) {
          pixelData[idx] = color[0]
          pixelData[idx + 1] = color[1]
          pixelData[idx + 2] = color[2]
          pixelData[idx + 3] = color[3]
        }
      }
    }),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      return {
        width: w,
        height: h,
        data: new Uint8ClampedArray(pixelData),
      }
    }),
    putImageData: vi.fn((imgData: ImageData, _x: number, _y: number) => {
      for (let i = 0; i < imgData.data.length; i++) {
        pixelData[i] = imgData.data[i]
      }
    }),
    get _pixelData() {
      return pixelData
    },
    getPixel: (px: number, py: number): [number, number, number, number] => {
      const idx = (py * width + px) * 4
      return [pixelData[idx], pixelData[idx + 1], pixelData[idx + 2], pixelData[idx + 3]]
    },
  }

  return ctx
}

describe('DrawingCanvas Fill Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the Fill tool button in the drawer toolbar with proper accessibility attributes', () => {
    render(
      <DrawingCanvas
        isDrawer={true}
        currentTurnId="turn-1"
        currentUserId="drawer-1"
      />
    )

    const fillButton = screen.getByRole('button', { name: /fill tool/i })
    expect(fillButton).toBeInTheDocument()
    expect(fillButton).toHaveAttribute('aria-pressed', 'false')

    // Click to select Fill tool
    fireEvent.click(fillButton)
    expect(fillButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('allows selecting colors from the palette while Fill tool is active', () => {
    render(
      <DrawingCanvas
        isDrawer={true}
        currentTurnId="turn-1"
        currentUserId="drawer-1"
      />
    )

    const fillButton = screen.getByRole('button', { name: /fill tool/i })
    fireEvent.click(fillButton)
    expect(fillButton).toHaveAttribute('aria-pressed', 'true')

    const blueButton = screen.getByRole('button', { name: /blue color/i })
    fireEvent.click(blueButton)

    // Palette button should be active and tool remains fill
    expect(blueButton).toHaveAttribute('aria-pressed', 'true')
    expect(fillButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('triggers onAppendStroke with fill tool payload when clicking the canvas in fill mode', () => {
    const mockAppendStroke = vi.fn().mockResolvedValue('stroke-fill-1')
    const width = 300
    const height = 220
    const mockContext = createMockCanvasContext(width, height)
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext)

    try {
      render(
        <DrawingCanvas
          isDrawer={true}
          currentTurnId="turn-1"
          currentUserId="drawer-1"
          onAppendStroke={mockAppendStroke}
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i }) as HTMLCanvasElement
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 300,
        height: 220,
        right: 300,
        bottom: 220,
        x: 0,
        y: 0,
        toJSON: () => {},
      })

      // Select Fill tool
      const fillButton = screen.getByRole('button', { name: /fill tool/i })
      fireEvent.click(fillButton)

      // Select Coral color
      const coralButton = screen.getByRole('button', { name: /coral color/i })
      fireEvent.click(coralButton)

      // Click on canvas at (150, 110) -> normalized (0.5, 0.5)
      fireEvent.pointerDown(canvas, { clientX: 150, clientY: 110, pointerId: 1 })

      expect(mockAppendStroke).toHaveBeenCalledTimes(1)
      const payload = mockAppendStroke.mock.calls[0][0]
      expect(payload).toMatchObject({
        tool: 'fill',
        color: '#f43f5e',
        authorId: 'drawer-1',
        turnId: 'turn-1',
        points: [{ x: 0.5, y: 0.5 }],
      })
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  it('does not append stroke when tapping the same color (same-color no-op)', () => {
    const mockAppendStroke = vi.fn().mockResolvedValue('stroke-fill-noop')
    const width = 300
    const height = 220
    const mockContext = createMockCanvasContext(width, height)
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext)

    // Pre-existing stroke fills the entire canvas Blue
    const strokes: Stroke[] = [
      {
        id: 's-blue-fill',
        turnId: 'turn-1',
        tool: 'fill',
        points: [{ x: 0.5, y: 0.5 }],
        color: '#3b82f6',
        size: 0,
        authorId: 'drawer-1',
        createdAt: 100,
      },
    ]

    try {
      render(
        <DrawingCanvas
          isDrawer={true}
          currentTurnId="turn-1"
          currentUserId="drawer-1"
          strokes={strokes}
          onAppendStroke={mockAppendStroke}
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i }) as HTMLCanvasElement
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 300,
        height: 220,
        right: 300,
        bottom: 220,
        x: 0,
        y: 0,
        toJSON: () => {},
      })

      // Select Fill tool
      const fillButton = screen.getByRole('button', { name: /fill tool/i })
      fireEvent.click(fillButton)

      // Select Blue color (#3b82f6)
      const blueButton = screen.getByRole('button', { name: /blue color/i })
      fireEvent.click(blueButton)

      // Click on canvas where pixels are already Blue
      fireEvent.pointerDown(canvas, { clientX: 150, clientY: 110, pointerId: 1 })

      // NO-OP: onAppendStroke must NOT be called
      expect(mockAppendStroke).not.toHaveBeenCalled()
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  it('replays fill operations along with existing pen strokes deterministically and verifies real rendered pixels', () => {
    const width = 300
    const height = 220
    const mockContext = createMockCanvasContext(width, height)
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext)

    // Closed box boundary from (60, 40) to (240, 180) in Black pen
    // Coordinates normalized to 300x220:
    // (60, 40) -> (0.2, 0.1818)
    // (240, 40) -> (0.8, 0.1818)
    // (240, 180) -> (0.8, 0.8182)
    // (60, 180) -> (0.2, 0.8182)
    // Interior is (150, 110) -> (0.5, 0.5)
    const strokes: Stroke[] = [
      {
        id: 's1',
        turnId: 'turn-1',
        points: [
          { x: 0.2, y: 0.1818 },
          { x: 0.8, y: 0.1818 },
          { x: 0.8, y: 0.8182 },
          { x: 0.2, y: 0.8182 },
          { x: 0.2, y: 0.1818 },
        ],
        color: '#0f172a',
        size: 7,
        tool: 'pen',
        authorId: 'drawer-1',
        createdAt: 100,
      },
      {
        id: 's2',
        turnId: 'turn-1',
        points: [{ x: 0.5, y: 0.5 }],
        color: '#3b82f6',
        size: 0,
        tool: 'fill',
        authorId: 'drawer-1',
        createdAt: 200,
      },
    ]

    try {
      render(
        <DrawingCanvas
          isDrawer={false}
          currentTurnId="turn-1"
          strokes={strokes}
        />
      )

      // Verified real pixel values rendered:
      // Inside box (150, 110) MUST be Blue
      expect(mockContext.getPixel(150, 110)).toEqual([59, 130, 246, 255])

      // Boundary (60, 40) MUST be Black pen stroke
      expect(mockContext.getPixel(60, 40)).toEqual([15, 23, 42, 255])

      // Outside box (20, 20) MUST remain White background (no leak!)
      expect(mockContext.getPixel(20, 20)).toEqual([255, 255, 255, 255])
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  it('P1 REGRESSION: preserves queued closing pen segment with delayed resolution, drains all queued writes, and matches fresh spectator replay to drawer scene', async () => {
    const width = 300
    const height = 220
    const mockContext = createMockCanvasContext(width, height)
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext)

    // Capture dispatched calls
    const dispatchedCalls: Array<{
      payload: Omit<Stroke, 'id' | 'createdAt'>
      resolve: (id: string) => void
    }> = []

    const mockAppendStroke = vi.fn().mockImplementation((payload) => {
      return new Promise<string>((resolve) => {
        dispatchedCalls.push({ payload, resolve })
      })
    })

    try {
      render(
        <DrawingCanvas
          isDrawer={true}
          currentTurnId="turn-1"
          currentUserId="drawer-1"
          onAppendStroke={mockAppendStroke}
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i }) as HTMLCanvasElement
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 300,
        height: 220,
        right: 300,
        bottom: 220,
        x: 0,
        y: 0,
        toJSON: () => {},
      })

      // 1. Drawer draws open segments of a box: (60, 40) -> (240, 40) -> (240, 180) -> (60, 180)
      fireEvent.pointerDown(canvas, { clientX: 60, clientY: 40, pointerId: 1 })
      fireEvent.pointerMove(canvas, { clientX: 240, clientY: 40, pointerId: 1 })
      fireEvent.pointerMove(canvas, { clientX: 240, clientY: 180, pointerId: 1 })
      fireEvent.pointerMove(canvas, { clientX: 60, clientY: 180, pointerId: 1 })
      // End first stroke
      fireEvent.pointerUp(canvas, { clientX: 60, clientY: 180, pointerId: 1 })

      // 2. Drawer draws closing segment: (60, 180) -> (60, 40)
      fireEvent.pointerDown(canvas, { clientX: 60, clientY: 180, pointerId: 2 })
      fireEvent.pointerMove(canvas, { clientX: 60, clientY: 40, pointerId: 2 })
      fireEvent.pointerUp(canvas, { clientX: 60, clientY: 40, pointerId: 2 })

      // Stroke 1 is in-flight, Stroke 2 is queued behind it
      expect(mockAppendStroke).toHaveBeenCalled()

      // 3. Drawer switches tool to 'fill'.
      // With localPendingStrokesRef, switching tool does not erase the unpersisted closing segment!
      const fillButton = screen.getByRole('button', { name: /fill tool/i })
      fireEvent.click(fillButton)
      expect(fillButton).toHaveAttribute('aria-pressed', 'true')

      // Select Coral color (#f43f5e)
      const coralButton = screen.getByRole('button', { name: /coral color/i })
      fireEvent.click(coralButton)

      // 4. Drawer clicks to fill INSIDE the box at (150, 110)
      fireEvent.pointerDown(canvas, { clientX: 150, clientY: 110, pointerId: 3 })

      // 5. Verify local drawer canvas pixels:
      // Inside box (150, 110) MUST be Coral [244, 63, 94, 255]
      expect(mockContext.getPixel(150, 110)).toEqual([244, 63, 94, 255])
      // Outside box (20, 20) MUST remain White [255, 255, 255, 255] (NO LEAK!)
      expect(mockContext.getPixel(20, 20)).toEqual([255, 255, 255, 255])

      // Snapshot the local canvas pixel data
      const localPixels = new Uint8ClampedArray(mockContext._pixelData)

      // 6. Drain and assert every queued write sequentially
      const persistedStrokes: Stroke[] = []
      let strokeIdCounter = 0

      for (let opIndex = 0; opIndex < 3; opIndex++) {
        await vi.waitFor(() => {
          expect(dispatchedCalls.length).toBeGreaterThan(0)
        })
        const call = dispatchedCalls.shift()!
        strokeIdCounter++
        const strokeId = `stroke-persisted-${strokeIdCounter}`
        persistedStrokes.push({
          ...call.payload,
          id: strokeId,
          createdAt: 100 + strokeIdCounter * 10,
        })
        call.resolve(strokeId)
        await new Promise((r) => setTimeout(r, 20))
      }

      // Assert all 3 writes drained: open box, closing segment, fill
      expect(persistedStrokes).toHaveLength(3)
      expect(persistedStrokes[0].tool).toBe('pen')
      expect(persistedStrokes[1].tool).toBe('pen')
      expect(persistedStrokes[2].tool).toBe('fill')

      // 7. Mount a fresh spectator with ONLY persisted operations
      const spectatorContext = createMockCanvasContext(width, height)
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(spectatorContext)

      render(
        <DrawingCanvas
          isDrawer={false}
          currentTurnId="turn-1"
          strokes={persistedStrokes}
        />
      )

      // Inside box in spectator replay MUST be Coral
      expect(spectatorContext.getPixel(150, 110)).toEqual([244, 63, 94, 255])
      // Outside box in spectator replay MUST remain White
      expect(spectatorContext.getPixel(20, 20)).toEqual([255, 255, 255, 255])

      // Verify that local canvas pixel data and spectator canvas pixel data match identically
      expect(spectatorContext._pixelData).toEqual(localPixels)
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  it('P1 RECONCILIATION: repeated identical fills separated by recoloring do not falsely consume historic identical operations', async () => {
    const width = 300
    const height = 220
    const mockContext = createMockCanvasContext(width, height)
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext)

    // Historical persisted strokes: Blue fill followed by Coral fill
    const historicStrokes: Stroke[] = [
      {
        id: 's-blue-1',
        turnId: 'turn-1',
        tool: 'fill',
        points: [{ x: 0.5, y: 0.5 }],
        color: '#3b82f6',
        size: 0,
        authorId: 'drawer-1',
        createdAt: 100,
        clientOpId: 'op-blue-1',
      },
      {
        id: 's-coral-2',
        turnId: 'turn-1',
        tool: 'fill',
        points: [{ x: 0.5, y: 0.5 }],
        color: '#f43f5e',
        size: 0,
        authorId: 'drawer-1',
        createdAt: 200,
        clientOpId: 'op-coral-2',
      },
    ]

    let resolveThirdStroke: ((id: string) => void) | null = null
    const mockAppendStroke = vi.fn().mockImplementation((payload) => {
      return new Promise<string>((resolve) => {
        resolveThirdStroke = resolve
      })
    })

    try {
      const { rerender } = render(
        <DrawingCanvas
          isDrawer={true}
          currentTurnId="turn-1"
          currentUserId="drawer-1"
          strokes={historicStrokes}
          onAppendStroke={mockAppendStroke}
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i }) as HTMLCanvasElement
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 300,
        height: 220,
        right: 300,
        bottom: 220,
        x: 0,
        y: 0,
        toJSON: () => {},
      })

      // Initially, canvas is Coral (from s-coral-2)
      expect(mockContext.getPixel(150, 110)).toEqual([244, 63, 94, 255])

      // Select Fill tool and Blue color
      const fillButton = screen.getByRole('button', { name: /fill tool/i })
      fireEvent.click(fillButton)
      const blueButton = screen.getByRole('button', { name: /blue color/i })
      fireEvent.click(blueButton)

      // Click to fill with Blue at (150, 110)
      fireEvent.pointerDown(canvas, { clientX: 150, clientY: 110, pointerId: 1 })

      expect(mockAppendStroke).toHaveBeenCalledTimes(1)
      // Optimistic canvas MUST be Blue, NOT reverted to Coral!
      expect(mockContext.getPixel(150, 110)).toEqual([59, 130, 246, 255])

      // Trigger a re-render while write is still pending (e.g. tool switch)
      // The pending blue fill must NOT be consumed by s-blue-1 from history!
      fireEvent.click(fillButton)
      expect(mockContext.getPixel(150, 110)).toEqual([59, 130, 246, 255])

      // Settle the third stroke write
      const thirdPayload = mockAppendStroke.mock.calls[0][0]
      resolveThirdStroke!('s-blue-3')

      const updatedStrokes: Stroke[] = [
        ...historicStrokes,
        {
          ...thirdPayload,
          id: 's-blue-3',
          createdAt: 300,
        },
      ]

      // Re-render with persisted strokes
      rerender(
        <DrawingCanvas
          isDrawer={true}
          currentTurnId="turn-1"
          currentUserId="drawer-1"
          strokes={updatedStrokes}
          onAppendStroke={mockAppendStroke}
        />
      )

      // Canvas remains Blue
      expect(mockContext.getPixel(150, 110)).toEqual([59, 130, 246, 255])

      // Mount fresh spectator
      const spectatorContext = createMockCanvasContext(width, height)
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(spectatorContext)
      render(
        <DrawingCanvas
          isDrawer={false}
          currentTurnId="turn-1"
          strokes={updatedStrokes}
        />
      )
      expect(spectatorContext.getPixel(150, 110)).toEqual([59, 130, 246, 255])
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  it('P1 QUEUED CLEAR: pending clear followed by fill with delayed writes avoids false no-op and replays correctly', async () => {
    const width = 300
    const height = 220
    const mockContext = createMockCanvasContext(width, height)
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext)

    // Canvas initially has a Blue fill
    const initialStrokes: Stroke[] = [
      {
        id: 's-blue-1',
        turnId: 'turn-1',
        tool: 'fill',
        points: [{ x: 0.5, y: 0.5 }],
        color: '#3b82f6',
        size: 0,
        authorId: 'drawer-1',
        createdAt: 100,
        clientOpId: 'op-blue-1',
      },
    ]

    const dispatchedQueue: Array<{
      kind: 'clear' | 'stroke'
      payload: any
      resolve: (id: string) => void
    }> = []

    const mockAppendStroke = vi.fn().mockImplementation((payload) => {
      return new Promise<string>((resolve) => {
        dispatchedQueue.push({ kind: 'stroke', payload, resolve })
      })
    })

    const mockClearCanvas = vi.fn().mockImplementation(() => {
      return new Promise<string>((resolve) => {
        dispatchedQueue.push({
          kind: 'clear',
          payload: { tool: 'clear', points: [], color: '#ffffff', size: 0, authorId: 'drawer-1', turnId: 'turn-1' },
          resolve,
        })
      })
    })

    try {
      render(
        <DrawingCanvas
          isDrawer={true}
          currentTurnId="turn-1"
          currentUserId="drawer-1"
          strokes={initialStrokes}
          onAppendStroke={mockAppendStroke}
          onClearCanvas={mockClearCanvas}
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i }) as HTMLCanvasElement
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 300,
        height: 220,
        right: 300,
        bottom: 220,
        x: 0,
        y: 0,
        toJSON: () => {},
      })

      // Canvas is initially Blue
      expect(mockContext.getPixel(150, 110)).toEqual([59, 130, 246, 255])

      // 1. Drawer clicks Clear. Write is delayed.
      const clearButton = screen.getByRole('button', { name: /clear canvas/i })
      fireEvent.click(clearButton)
      expect(mockClearCanvas).toHaveBeenCalledTimes(1)

      // Optimistic canvas is wiped to White
      expect(mockContext.getPixel(150, 110)).toEqual([255, 255, 255, 255])

      // 2. Before Clear settles, drawer selects Fill tool and Blue color, then clicks at (150, 110)
      const fillButton = screen.getByRole('button', { name: /fill tool/i })
      fireEvent.click(fillButton)
      const blueButton = screen.getByRole('button', { name: /blue color/i })
      fireEvent.click(blueButton)

      // Clicking at (150, 110) with Blue
      // This MUST NOT be treated as a same-color no-op!
      fireEvent.pointerDown(canvas, { clientX: 150, clientY: 110, pointerId: 1 })

      // Optimistic canvas MUST be Blue!
      expect(mockContext.getPixel(150, 110)).toEqual([59, 130, 246, 255])

      // 3. Settle all queued operations in order:
      // First operation: clear
      expect(dispatchedQueue).toHaveLength(1)
      const clearCall = dispatchedQueue.shift()!
      expect(clearCall.kind).toBe('clear')
      await act(async () => {
        clearCall.resolve('s-clear-2')
      })

      // Wait for fill stroke to be dispatched next
      await vi.waitFor(() => {
        expect(dispatchedQueue.length).toBeGreaterThan(0)
      })
      const fillCall = dispatchedQueue.shift()!
      expect(fillCall.kind).toBe('stroke')
      expect(fillCall.payload.tool).toBe('fill')
      expect(fillCall.payload.color).toBe('#3b82f6')
      await act(async () => {
        fillCall.resolve('s-blue-3')
      })

      // Build complete persisted stroke list: [s-blue-1, s-clear-2, s-blue-3]
      const persistedStrokes: Stroke[] = [
        ...initialStrokes,
        {
          id: 's-clear-2',
          turnId: 'turn-1',
          tool: 'clear',
          points: [],
          color: '#ffffff',
          size: 0,
          authorId: 'drawer-1',
          createdAt: 200,
        },
        {
          ...fillCall.payload,
          id: 's-blue-3',
          createdAt: 300,
        },
      ]

      // Mount fresh spectator
      const spectatorContext = createMockCanvasContext(width, height)
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(spectatorContext)

      render(
        <DrawingCanvas
          isDrawer={false}
          currentTurnId="turn-1"
          strokes={persistedStrokes}
        />
      )

      // Spectator canvas MUST be Blue (replaying clear then blue fill)
      expect(spectatorContext.getPixel(150, 110)).toEqual([59, 130, 246, 255])
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  it('P2 CANCELLATION: pointer cancellation removes optimistic queued segments so they do not affect subsequent fill', () => {
    const width = 300
    const height = 220
    const mockContext = createMockCanvasContext(width, height)
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext)

    const mockAppendStroke = vi.fn().mockReturnValue(new Promise(() => {})) // pending forever

    try {
      render(
        <DrawingCanvas
          isDrawer={true}
          currentTurnId="turn-1"
          currentUserId="drawer-1"
          onAppendStroke={mockAppendStroke}
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i }) as HTMLCanvasElement
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 300,
        height: 220,
        right: 300,
        bottom: 220,
        x: 0,
        y: 0,
        toJSON: () => {},
      })

      // Drawer starts drawing a line from (50, 50) to (250, 50)
      fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, pointerId: 1 })
      fireEvent.pointerMove(canvas, { clientX: 250, clientY: 50, pointerId: 1 })

      // Gesture is canceled
      fireEvent.pointerCancel(canvas, { pointerId: 1 })

      // Canvas should be completely clean (white) after cancel
      expect(mockContext.getPixel(50, 50)).toEqual([255, 255, 255, 255])
      expect(mockContext.getPixel(150, 50)).toEqual([255, 255, 255, 255])

      // Select Fill tool and Mint color
      const fillButton = screen.getByRole('button', { name: /fill tool/i })
      fireEvent.click(fillButton)
      const mintButton = screen.getByRole('button', { name: /mint color/i })
      fireEvent.click(mintButton)

      // Click to fill at (150, 110)
      fireEvent.pointerDown(canvas, { clientX: 150, clientY: 110, pointerId: 2 })

      // Canvas should be filled with Mint (not blocked or divided by canceled gesture)
      expect(mockContext.getPixel(150, 110)).toEqual([16, 185, 129, 255])
      expect(mockContext.getPixel(50, 50)).toEqual([16, 185, 129, 255])
      expect(mockContext.getPixel(150, 50)).toEqual([16, 185, 129, 255])
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })

  it('P2 EDGES & RESIZE: clamps normalized coordinates safely across canvas sizes and prevents out-of-bounds errors', () => {
    // Test on 300x220 canvas: Math.round(0.999 * 300) = 300, clamped safely to 299
    const width = 300
    const height = 220
    const mockContext = createMockCanvasContext(width, height)
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext)

    const mockAppendStroke = vi.fn().mockResolvedValue('stroke-edge-1')

    try {
      render(
        <DrawingCanvas
          isDrawer={true}
          currentTurnId="turn-1"
          currentUserId="drawer-1"
          onAppendStroke={mockAppendStroke}
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i }) as HTMLCanvasElement
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 300,
        height: 220,
        right: 300,
        bottom: 220,
        x: 0,
        y: 0,
        toJSON: () => {},
      })

      // Select Fill tool and Mint color
      const fillButton = screen.getByRole('button', { name: /fill tool/i })
      fireEvent.click(fillButton)
      const mintButton = screen.getByRole('button', { name: /mint color/i })
      fireEvent.click(mintButton)

      // Click at the extreme bottom-right edge: clientX = 299.8, clientY = 219.8
      fireEvent.pointerDown(canvas, { clientX: 299.8, clientY: 219.8, pointerId: 1 })

      expect(mockAppendStroke).toHaveBeenCalledTimes(1)
      const payload = mockAppendStroke.mock.calls[0][0]
      expect(payload.tool).toBe('fill')
      expect(payload.color).toBe('#10b981')

      // Pixel (299, 219) must be Mint (clamped safely, no crash)
      expect(mockContext.getPixel(299, 219)).toEqual([16, 185, 129, 255])
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })
})
