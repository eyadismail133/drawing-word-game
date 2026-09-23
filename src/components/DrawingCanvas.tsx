import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { Stroke, StrokePoint } from '../features/room/types'

export type DrawingCanvasProps = {
  strokes?: Record<string, Stroke> | Stroke[]
  currentTurnId?: string
  isDrawer: boolean
  onAppendStroke?: (stroke: Omit<Stroke, 'id' | 'createdAt'>) => Promise<string> | void
  onClearCanvas?: () => Promise<string | void> | void
  currentUserId?: string
  disabled?: boolean
}

export const PALETTE_COLORS = [
  { name: 'Black', hex: '#0f172a' },
  { name: 'Coral', hex: '#f43f5e' },
  { name: 'Mint', hex: '#10b981' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Yellow', hex: '#f59e0b' },
  { name: 'Purple', hex: '#8b5cf6' },
  { name: 'Brown', hex: '#78350f' },
  { name: 'White', hex: '#ffffff' },
]

export const BRUSH_SIZES = [
  { label: 'S', size: 3, name: 'Small' },
  { label: 'M', size: 7, name: 'Medium' },
  { label: 'L', size: 14, name: 'Large' },
]

export const STREAM_BATCH_INTERVAL_MS = 166

export function normalizePoint(
  px: number,
  py: number,
  width: number,
  height: number
): StrokePoint {
  if (width <= 0 || height <= 0) return { x: 0, y: 0 }
  const x = Math.max(0, Math.min(1, px / width))
  const y = Math.max(0, Math.min(1, py / height))
  return {
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
  }
}

export function denormalizePoint(
  point: StrokePoint,
  width: number,
  height: number
): { x: number; y: number } {
  return {
    x: point.x * width,
    y: point.y * height,
  }
}

export function DrawingCanvas({
  strokes = {},
  currentTurnId,
  isDrawer,
  onAppendStroke,
  onClearCanvas,
  currentUserId = '',
  disabled = false,
}: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const [color, setColor] = useState<string>('#0f172a')
  const [size, setSize] = useState<number>(7)
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [isClearing, setIsClearing] = useState<boolean>(false)
  const isDrawingRef = useRef<boolean>(false)
  const currentPointsRef = useRef<StrokePoint[]>([])
  const lastBatchTimeRef = useRef<number>(0)
  const lastSentIndexRef = useRef<number>(-1)
  type QueueItem =
    | { kind: 'stroke'; payload: Omit<Stroke, 'id' | 'createdAt'> }
    | { kind: 'clear'; resolve: () => void; reject: (err: unknown) => void }

  const isAppendingRef = useRef<boolean>(false)
  const isInFlightRef = useRef<boolean>(false)
  const pendingQueueRef = useRef<QueueItem[]>([])
  const queueResolversRef = useRef<Array<() => void>>([])
  const lastInvocationTimeRef = useRef<number>(0)
  const dispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const rawStrokeList: Stroke[] = useMemo(() => {
    return Array.isArray(strokes) ? strokes : Object.values(strokes ?? {})
  }, [strokes])

  // Filter strokes strictly by current turn if turnId is specified
  const strokeList = useMemo(() => {
    if (!currentTurnId) return rawStrokeList
    return rawStrokeList.filter((s) => !s.turnId || s.turnId === currentTurnId)
  }, [rawStrokeList, currentTurnId])

  // Replay all persisted strokes onto the canvas, preserving in-progress strokes
  const renderAllStrokes = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    // Sort by createdAt or push id to maintain deterministic order (code-unit comparison)
    const sorted = [...strokeList].sort(
      (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )

    // Clear marker: find last clear stroke and only render strokes after it
    const lastClearIndex = sorted.map((s) => s.tool).lastIndexOf('clear')
    const visibleStrokes = lastClearIndex >= 0 ? sorted.slice(lastClearIndex + 1) : sorted

    for (const stroke of visibleStrokes) {
      if (!stroke.points || stroke.points.length === 0) continue

      ctx.beginPath()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(1, stroke.size * (width / 600))

      if (stroke.tool === 'eraser') {
        ctx.strokeStyle = '#ffffff'
      } else {
        ctx.strokeStyle = stroke.color
      }

      if (stroke.points.length === 1) {
        const pt = denormalizePoint(stroke.points[0], width, height)
        ctx.arc(pt.x, pt.y, ctx.lineWidth / 2, 0, Math.PI * 2)
        ctx.fillStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color
        ctx.fill()
      } else {
        const first = denormalizePoint(stroke.points[0], width, height)
        ctx.moveTo(first.x, first.y)
        for (let i = 1; i < stroke.points.length; i++) {
          const pt = denormalizePoint(stroke.points[i], width, height)
          ctx.lineTo(pt.x, pt.y)
        }
        ctx.stroke()
      }
    }

    // Preserve and redraw active in-progress gesture if drawing
    if (isDrawingRef.current && currentPointsRef.current.length > 0) {
      const pts = currentPointsRef.current
      ctx.beginPath()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(1, size * (width / 600))
      ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : color

      if (pts.length === 1) {
        const pt = denormalizePoint(pts[0], width, height)
        ctx.arc(pt.x, pt.y, ctx.lineWidth / 2, 0, Math.PI * 2)
        ctx.fillStyle = tool === 'eraser' ? '#ffffff' : color
        ctx.fill()
      } else {
        const first = denormalizePoint(pts[0], width, height)
        ctx.moveTo(first.x, first.y)
        for (let i = 1; i < pts.length; i++) {
          const pt = denormalizePoint(pts[i], width, height)
          ctx.lineTo(pt.x, pt.y)
        }
        ctx.stroke()
      }
    }
  }, [strokeList, size, color, tool])

  // Resize canvas according to container dimensions
  useEffect(() => {
    const updateCanvasSize = () => {
      const container = containerRef.current
      const canvas = canvasRef.current
      if (!container || !canvas) return

      const rect = container.getBoundingClientRect()
      const displayWidth = Math.max(300, Math.floor(rect.width))
      // Maintain 4:3 aspect ratio or responsive height
      const displayHeight = Math.max(220, Math.floor(displayWidth * 0.72))

      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth
        canvas.height = displayHeight
        renderAllStrokes()
      }
    }

    updateCanvasSize()
    window.addEventListener('resize', updateCanvasSize)
    return () => window.removeEventListener('resize', updateCanvasSize)
  }, [renderAllStrokes])

  // Re-render strokes whenever list changes
  useEffect(() => {
    renderAllStrokes()
  }, [renderAllStrokes])

  const getCanvasPoint = (e: PointerEvent<HTMLCanvasElement>): StrokePoint => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const clientX = typeof e.clientX === 'number' && !Number.isNaN(e.clientX) ? e.clientX : 0
    const clientY = typeof e.clientY === 'number' && !Number.isNaN(e.clientY) ? e.clientY : 0
    const px = clientX - rect.left
    const py = clientY - rect.top
    return normalizePoint(px, py, rect.width, rect.height)
  }

  useEffect(() => {
    return () => {
      if (dispatchTimerRef.current) {
        clearTimeout(dispatchTimerRef.current)
        dispatchTimerRef.current = null
      }
      const items = pendingQueueRef.current
      pendingQueueRef.current = []
      items.forEach((item) => {
        if (item.kind === 'clear') {
          item.reject(new Error('DrawingCanvas unmounted'))
        }
      })
      const resolvers = queueResolversRef.current
      queueResolversRef.current = []
      resolvers.forEach((res) => res())
    }
  }, [])

  const processAppendQueue = useCallback(() => {
    if (isAppendingRef.current) return
    isAppendingRef.current = true

    const executeNext = () => {
      dispatchTimerRef.current = null
      if (pendingQueueRef.current.length === 0) {
        isInFlightRef.current = false
        isAppendingRef.current = false
        const resolvers = queueResolversRef.current
        queueResolversRef.current = []
        resolvers.forEach((res) => res())
        return
      }

      const nextItem = pendingQueueRef.current.shift()!
      lastInvocationTimeRef.current = Date.now()
      isInFlightRef.current = true

      if (nextItem.kind === 'stroke') {
        if (!onAppendStroke) {
          isInFlightRef.current = false
          scheduleNext()
          return
        }

        let promise: Promise<unknown>
        try {
          const res = onAppendStroke(nextItem.payload)
          promise = res instanceof Promise ? res : Promise.resolve(res)
        } catch {
          renderAllStrokes()
          promise = Promise.resolve()
        }

        promise
          .catch(() => {
            renderAllStrokes()
          })
          .finally(() => {
            isInFlightRef.current = false
            scheduleNext()
          })
      } else {
        // nextItem.kind === 'clear'
        let clearPromise: Promise<unknown>
        try {
          if (onClearCanvas) {
            const res = onClearCanvas()
            clearPromise = res instanceof Promise ? res : Promise.resolve(res)
          } else if (onAppendStroke) {
            const res = onAppendStroke({
              authorId: currentUserId,
              turnId: currentTurnId,
              tool: 'clear',
              points: [],
              color: '#ffffff',
              size: 0,
            })
            clearPromise = res instanceof Promise ? res : Promise.resolve(res)
          } else {
            clearPromise = Promise.resolve()
          }
        } catch (err) {
          clearPromise = Promise.reject(err)
        }

        clearPromise
          .then(() => {
            nextItem.resolve()
          })
          .catch((err) => {
            renderAllStrokes()
            nextItem.reject(err)
          })
          .finally(() => {
            isInFlightRef.current = false
            scheduleNext()
          })
      }
    }

    const scheduleNext = () => {
      if (pendingQueueRef.current.length === 0) {
        isInFlightRef.current = false
        isAppendingRef.current = false
        const resolvers = queueResolversRef.current
        queueResolversRef.current = []
        resolvers.forEach((res) => res())
        return
      }

      const nextItem = pendingQueueRef.current[0]
      const now = Date.now()
      const elapsed = now - lastInvocationTimeRef.current
      const remainingDelay = STREAM_BATCH_INTERVAL_MS - elapsed

      if (nextItem.kind === 'stroke' && lastInvocationTimeRef.current > 0 && remainingDelay > 0) {
        dispatchTimerRef.current = setTimeout(executeNext, remainingDelay)
      } else {
        executeNext()
      }
    }

    scheduleNext()
  }, [onAppendStroke, onClearCanvas, currentUserId, currentTurnId, renderAllStrokes])

  const enqueueAppend = useCallback(
    (strokePayload: Omit<Stroke, 'id' | 'createdAt'>) => {
      pendingQueueRef.current.push({ kind: 'stroke', payload: strokePayload })
      processAppendQueue()
    },
    [processAppendQueue]
  )

  const enqueueClear = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      pendingQueueRef.current.push({ kind: 'clear', resolve, reject })
      processAppendQueue()
    })
  }, [processAppendQueue])

  const waitForAppendQueue = useCallback((): Promise<void> => {
    if (!isAppendingRef.current && pendingQueueRef.current.length === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      queueResolversRef.current.push(resolve)
    })
  }, [])

  const flushBatch = useCallback(() => {
    if (!onAppendStroke) return
    const allPoints = currentPointsRef.current
    if (allPoints.length === 0) return

    const lastSentIndex = lastSentIndexRef.current
    const hasUnsentPoints = allPoints.length - 1 > lastSentIndex
    if (!hasUnsentPoints) return

    let batchPoints: StrokePoint[]
    if (lastSentIndex < 0) {
      batchPoints = allPoints.slice(0)
    } else {
      batchPoints = allPoints.slice(lastSentIndex)
    }

    lastSentIndexRef.current = allPoints.length - 1
    lastBatchTimeRef.current = Date.now()

    enqueueAppend({
      turnId: currentTurnId,
      points: batchPoints,
      color: tool === 'eraser' ? '#ffffff' : color,
      size,
      tool,
      authorId: currentUserId,
    })
  }, [currentTurnId, tool, color, size, currentUserId, onAppendStroke, enqueueAppend])

  const handlePointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawer || disabled || !onAppendStroke) return
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.setPointerCapture(e.pointerId)
    isDrawingRef.current = true

    const point = getCanvasPoint(e)
    currentPointsRef.current = [point]
    lastSentIndexRef.current = -1
    lastBatchTimeRef.current = Date.now()

    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.beginPath()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(1, size * (canvas.width / 600))
      ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : color
      const pt = denormalizePoint(point, canvas.width, canvas.height)
      ctx.arc(pt.x, pt.y, ctx.lineWidth / 2, 0, Math.PI * 2)
      ctx.fillStyle = tool === 'eraser' ? '#ffffff' : color
      ctx.fill()
    }
  }

  const handlePointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || !isDrawer || disabled) return
    const canvas = canvasRef.current
    if (!canvas) return

    const point = getCanvasPoint(e)
    const points = currentPointsRef.current
    const prevPoint = points[points.length - 1]
    points.push(point)

    const ctx = canvas.getContext('2d')
    if (ctx && prevPoint) {
      ctx.beginPath()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(1, size * (canvas.width / 600))
      ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : color

      const from = denormalizePoint(prevPoint, canvas.width, canvas.height)
      const to = denormalizePoint(point, canvas.width, canvas.height)
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }

    const now = Date.now()
    if (now - lastBatchTimeRef.current >= STREAM_BATCH_INTERVAL_MS) {
      flushBatch()
    }
  }

  const handlePointerUp = async (e: PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return
    isDrawingRef.current = false

    const canvas = canvasRef.current
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {}
    }

    flushBatch()
    currentPointsRef.current = []
    lastSentIndexRef.current = -1

    try {
      await waitForAppendQueue()
    } catch {
      renderAllStrokes()
    }
  }

  const handlePointerCancel = () => {
    isDrawingRef.current = false
    currentPointsRef.current = []
    lastSentIndexRef.current = -1

    // Settle any queued clear operations so isClearing cannot remain stuck
    const clearItems: Array<Extract<QueueItem, { kind: 'clear' }>> = []
    pendingQueueRef.current = pendingQueueRef.current.filter((item) => {
      if (item.kind === 'clear') {
        clearItems.push(item)
        return false
      }
      return false // Discard not-yet-dispatched stroke work from the cancelled gesture
    })
    clearItems.forEach((item) => {
      item.reject(new Error('Clear cancelled by pointer cancel'))
    })

    // If no request is in flight, clear timer and mark pipeline idle.
    // If a request is in flight, preserve strict queue ownership (isAppendingRef remains true)
    // so subsequent gestures do not launch concurrent appends and old completion
    // correctly schedules newer queue items.
    if (!isInFlightRef.current) {
      if (dispatchTimerRef.current) {
        clearTimeout(dispatchTimerRef.current)
        dispatchTimerRef.current = null
      }
      isAppendingRef.current = false
      const resolvers = queueResolversRef.current
      queueResolversRef.current = []
      resolvers.forEach((res) => res())
    }

    renderAllStrokes()
  }

  const handleClear = async () => {
    if (disabled || !isDrawer || isClearing) return
    setIsClearing(true)
    isDrawingRef.current = false
    currentPointsRef.current = []
    lastSentIndexRef.current = -1

    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
    }

    try {
      await enqueueClear()
    } catch {
      renderAllStrokes()
    } finally {
      setIsClearing(false)
    }
  }

  return (
    <div className="drawing-canvas-container" ref={containerRef}>
      <div className="canvas-wrapper">
        <canvas
          ref={canvasRef}
          className={`drawing-canvas ${isDrawer && !disabled ? 'is-active-drawer' : 'is-readonly'}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          tabIndex={0}
          role="img"
          aria-label={
            isDrawer
              ? 'Drawing canvas. Use touch or mouse to draw.'
              : "Drawing canvas showing the drawer's sketch."
          }
        />
      </div>

      {isDrawer && !disabled && (
        <div className="canvas-toolbar" role="toolbar" aria-label="Drawing tools">
          <div className="toolbar-section toolbar-tools" role="group" aria-label="Tool mode">
            <button
              type="button"
              className={`btn-tool ${tool === 'pen' ? 'active' : ''}`}
              onClick={() => setTool('pen')}
              aria-label="Pen tool"
              aria-pressed={tool === 'pen'}
            >
              ✏️ Pen
            </button>
            <button
              type="button"
              className={`btn-tool ${tool === 'eraser' ? 'active' : ''}`}
              onClick={() => setTool('eraser')}
              aria-label="Eraser tool"
              aria-pressed={tool === 'eraser'}
            >
              🧹 Eraser
            </button>
            <button
              type="button"
              className="btn-tool btn-clear-canvas"
              onClick={handleClear}
              aria-label="Clear canvas"
              disabled={isClearing}
            >
              🗑️ Clear
            </button>
          </div>

          <div className="toolbar-section toolbar-sizes" role="group" aria-label="Brush size">
            {BRUSH_SIZES.map((b) => (
              <button
                key={b.size}
                type="button"
                className={`btn-size ${size === b.size ? 'active' : ''}`}
                onClick={() => setSize(b.size)}
                aria-label={`${b.name} brush`}
                aria-pressed={size === b.size}
              >
                <span
                  className="brush-preview-dot"
                  style={{
                    width: `${Math.min(16, b.size + 4)}px`,
                    height: `${Math.min(16, b.size + 4)}px`,
                  }}
                  aria-hidden="true"
                />
                <span className="sr-only">{b.name}</span>
              </button>
            ))}
          </div>

          <div className="toolbar-section toolbar-palette" role="group" aria-label="Color palette">
            {PALETTE_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                className={`btn-color ${color === c.hex && tool === 'pen' ? 'active' : ''}`}
                style={{ backgroundColor: c.hex }}
                onClick={() => {
                  setColor(c.hex)
                  if (tool === 'eraser') setTool('pen')
                }}
                aria-label={`${c.name} color`}
                aria-pressed={color === c.hex && tool === 'pen'}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
