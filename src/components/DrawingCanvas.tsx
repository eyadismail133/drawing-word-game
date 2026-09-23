import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { Stroke, StrokePoint } from '../features/room/types'
import { executeFloodFillOnCanvas, normalizedToPixel } from '../features/drawing/floodFill'

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

export function matchesStroke(
  pending: Omit<Stroke, 'id' | 'createdAt'>,
  persisted: Stroke
): boolean {
  if (pending.tool !== persisted.tool) return false
  if (pending.authorId !== persisted.authorId) return false
  if (pending.turnId && persisted.turnId && pending.turnId !== persisted.turnId) return false
  if (pending.color !== persisted.color) return false
  if (pending.size !== persisted.size) return false
  const p1 = pending.points ?? []
  const p2 = persisted.points ?? []
  if (p1.length !== p2.length) return false
  for (let i = 0; i < p1.length; i++) {
    if (Math.abs(p1[i].x - p2[i].x) > 0.0001 || Math.abs(p1[i].y - p2[i].y) > 0.0001) {
      return false
    }
  }
  return true
}

export function matchesPendingWithPersisted(
  pending: {
    tool: 'pen' | 'eraser' | 'clear' | 'fill'
    color: string
    size: number
    authorId: string
    turnId?: string
    points?: StrokePoint[]
    clientOpId?: string
    persistedId?: string
    persistedIdsAtCreation: Set<string>
  },
  persisted: Stroke
): boolean {
  // 1. Exact match by stable client operation ID if both have it
  if (pending.clientOpId && persisted.clientOpId) {
    return pending.clientOpId === persisted.clientOpId
  }

  // 2. Exact match by returned persistence ID if captured
  if (pending.persistedId) {
    return pending.persistedId === persisted.id
  }

  // 3. Sound ordered reconciliation:
  // Cannot match any historical stroke that was already persisted when this pending operation was created
  if (pending.persistedIdsAtCreation.has(persisted.id)) {
    return false
  }

  // Match content attributes for non-historical strokes
  return matchesStroke(pending, persisted)
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
  const [tool, setTool] = useState<'pen' | 'eraser' | 'fill'>('pen')
  const [isClearing, setIsClearing] = useState<boolean>(false)
  const isDrawingRef = useRef<boolean>(false)
  const currentPointsRef = useRef<StrokePoint[]>([])
  const lastBatchTimeRef = useRef<number>(0)
  const lastSentIndexRef = useRef<number>(-1)

  type LocalPendingStroke = Omit<Stroke, 'id' | 'createdAt'> & {
    localId: string
    createdAt: number
    clientOpId?: string
    persistedId?: string
    persistedIdsAtCreation: Set<string>
  }
  const localPendingStrokesRef = useRef<LocalPendingStroke[]>([])

  type QueueItem =
    | { kind: 'stroke'; payload: Omit<Stroke, 'id' | 'createdAt'>; localId: string }
    | {
        kind: 'clear'
        payload: Omit<Stroke, 'id' | 'createdAt'>
        localId: string
        resolve: () => void
        reject: (err: unknown) => void
      }

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

  const drawStroke = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      stroke: {
        tool: 'pen' | 'eraser' | 'clear' | 'fill'
        points?: StrokePoint[]
        color: string
        size: number
      },
      width: number,
      height: number
    ) => {
      if (stroke.tool === 'clear') {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, width, height)
        return
      }

      if (!stroke.points || stroke.points.length === 0) return

      if (stroke.tool === 'fill') {
        const pixel = normalizedToPixel(stroke.points[0].x, stroke.points[0].y, width, height)
        executeFloodFillOnCanvas(ctx, pixel.x, pixel.y, stroke.color)
        return
      }

      ctx.beginPath()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(1, stroke.size * (width / 600))
      ctx.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color

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
    },
    []
  )

  // Replay all persisted strokes onto the canvas, preserving in-progress and unpersisted local strokes
  const renderAllStrokes = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    // Sort persisted strokes by timestamp and stable code-unit ID order
    const sorted = [...strokeList].sort(
      (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )

    // Reconcile and prune local pending strokes that are now in sorted persisted strokes
    const matchedPersistedIds = new Set<string>()
    localPendingStrokesRef.current = localPendingStrokesRef.current.filter((pending) => {
      if (currentTurnId && pending.turnId && pending.turnId !== currentTurnId) {
        return false
      }
      const match = sorted.find(
        (s) => !matchedPersistedIds.has(s.id) && matchesPendingWithPersisted(pending, s)
      )
      if (match) {
        matchedPersistedIds.add(match.id)
        return false
      }
      return true
    })

    // Check for clear markers in local pending strokes vs persisted strokes
    const lastPendingClearIndex = localPendingStrokesRef.current
      .map((s) => s.tool)
      .lastIndexOf('clear')

    if (lastPendingClearIndex >= 0) {
      // An unpersisted local clear is active: all persisted strokes precede it and must not be rendered!
      // Only render pending strokes enqueued AFTER the last pending clear:
      const visiblePending = localPendingStrokesRef.current.slice(lastPendingClearIndex + 1)
      for (const pending of visiblePending) {
        drawStroke(ctx, pending, width, height)
      }
    } else {
      // Clear marker in persisted strokes
      const lastClearIndex = sorted.map((s) => s.tool).lastIndexOf('clear')
      const visibleStrokes = lastClearIndex >= 0 ? sorted.slice(lastClearIndex + 1) : sorted

      for (const stroke of visibleStrokes) {
        drawStroke(ctx, stroke, width, height)
      }

      // Preserve local unpersisted strokes so tool switches or delayed appends do not wipe the scene
      for (const pending of localPendingStrokesRef.current) {
        drawStroke(ctx, pending, width, height)
      }
    }

    // Preserve and redraw active in-progress gesture if drawing
    if (isDrawingRef.current && currentPointsRef.current.length > 0) {
      drawStroke(
        ctx,
        {
          tool: tool === 'fill' ? 'pen' : tool,
          points: currentPointsRef.current,
          color,
          size,
        },
        width,
        height
      )
    }
  }, [strokeList, currentTurnId, tool, color, size, drawStroke])

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
          localPendingStrokesRef.current = localPendingStrokesRef.current.filter(
            (s) => s.localId !== nextItem.localId
          )
          renderAllStrokes()
          promise = Promise.resolve()
        }

        promise
          .then((persistedResult) => {
            if (typeof persistedResult === 'string' && persistedResult) {
              const pending = localPendingStrokesRef.current.find(
                (s) => s.localId === nextItem.localId
              )
              if (pending) {
                pending.persistedId = persistedResult
              }
            }
          })
          .catch(() => {
            localPendingStrokesRef.current = localPendingStrokesRef.current.filter(
              (s) => s.localId !== nextItem.localId
            )
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
            const res = onAppendStroke(nextItem.payload)
            clearPromise = res instanceof Promise ? res : Promise.resolve(res)
          } else {
            clearPromise = Promise.resolve()
          }
        } catch (err) {
          clearPromise = Promise.reject(err)
        }

        clearPromise
          .then((persistedResult) => {
            if (typeof persistedResult === 'string' && persistedResult) {
              const pending = localPendingStrokesRef.current.find(
                (s) => s.localId === nextItem.localId
              )
              if (pending) {
                pending.persistedId = persistedResult
              }
            }
            nextItem.resolve()
          })
          .catch((err) => {
            localPendingStrokesRef.current = localPendingStrokesRef.current.filter(
              (s) => s.localId !== nextItem.localId
            )
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
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      const clientOpId =
        strokePayload.clientOpId ??
        `op-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      const fullPayload = { ...strokePayload, clientOpId }
      const persistedIdsAtCreation = new Set(strokeList.map((s) => s.id))
      localPendingStrokesRef.current.push({
        ...fullPayload,
        localId,
        createdAt: Date.now(),
        clientOpId,
        persistedIdsAtCreation,
      })
      pendingQueueRef.current.push({ kind: 'stroke', payload: fullPayload, localId })
      processAppendQueue()
    },
    [strokeList, processAppendQueue]
  )

  const enqueueClear = useCallback(
    (clearPayload: Omit<Stroke, 'id' | 'createdAt'>, localId: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        pendingQueueRef.current.push({
          kind: 'clear',
          payload: clearPayload,
          localId,
          resolve,
          reject,
        })
        processAppendQueue()
      })
    },
    [processAppendQueue]
  )

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

    if (tool === 'fill') {
      flushBatch()
      renderAllStrokes()
      const point = getCanvasPoint(e)
      const pixel = normalizedToPixel(point.x, point.y, canvas.width, canvas.height)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const changed = executeFloodFillOnCanvas(
          ctx,
          pixel.x,
          pixel.y,
          color
        )
        if (changed) {
          enqueueAppend({
            turnId: currentTurnId,
            points: [point],
            color,
            size: 0,
            tool: 'fill',
            authorId: currentUserId,
          })
        }
      }
      return
    }

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

    // Collect localIds of discarded queued strokes so optimistic state is cleaned up
    const discardedLocalIds = new Set<string>()

    // Settle any queued clear operations so isClearing cannot remain stuck
    const clearItems: Array<Extract<QueueItem, { kind: 'clear' }>> = []
    pendingQueueRef.current = pendingQueueRef.current.filter((item) => {
      if (item.kind === 'clear') {
        clearItems.push(item)
        return false
      }
      discardedLocalIds.add(item.localId)
      return false // Discard not-yet-dispatched stroke work from the cancelled gesture
    })
    clearItems.forEach((item) => {
      item.reject(new Error('Clear cancelled by pointer cancel'))
    })

    // Remove discarded optimistic operations from localPendingStrokesRef,
    // while preserving any in-flight operation currently being processed
    localPendingStrokesRef.current = localPendingStrokesRef.current.filter(
      (s) => !discardedLocalIds.has(s.localId)
    )

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

    const clearLocalId = `clear-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const clearPayload: Omit<Stroke, 'id' | 'createdAt'> = {
      authorId: currentUserId,
      turnId: currentTurnId,
      tool: 'clear',
      points: [],
      color: '#ffffff',
      size: 0,
      clientOpId: clearLocalId,
    }

    // Add optimistic clear marker to localPendingStrokesRef
    localPendingStrokesRef.current.push({
      ...clearPayload,
      localId: clearLocalId,
      createdAt: Date.now(),
      clientOpId: clearLocalId,
      persistedIdsAtCreation: new Set(strokeList.map((s) => s.id)),
    })

    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
    }

    try {
      await enqueueClear(clearPayload, clearLocalId)
    } catch {
      localPendingStrokesRef.current = localPendingStrokesRef.current.filter(
        (s) => s.localId !== clearLocalId
      )
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
              className={`btn-tool ${tool === 'fill' ? 'active' : ''}`}
              onClick={() => setTool('fill')}
              aria-label="Fill tool"
              aria-pressed={tool === 'fill'}
            >
              🪣 Fill
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
            {PALETTE_COLORS.map((c) => {
              const isColorActive = color === c.hex && (tool === 'pen' || tool === 'fill')
              return (
                <button
                  key={c.hex}
                  type="button"
                  className={`btn-color ${isColorActive ? 'active' : ''}`}
                  style={{ backgroundColor: c.hex }}
                  onClick={() => {
                    setColor(c.hex)
                    if (tool === 'eraser') setTool('pen')
                  }}
                  aria-label={`${c.name} color`}
                  aria-pressed={isColorActive}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
