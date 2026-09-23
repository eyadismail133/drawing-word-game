export type ImageDataLike = {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

export type RgbaColor = [number, number, number, number]

/**
 * Converts a hex color string (#rgb, #rrggbb) to RGBA tuple [r, g, b, 255].
 */
export function hexToRgba(hex: string): RgbaColor {
  let cleaned = hex.replace('#', '').trim()
  if (cleaned.length === 3) {
    cleaned = cleaned
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16)
    const g = parseInt(cleaned.slice(2, 4), 16)
    const b = parseInt(cleaned.slice(4, 6), 16)
    return [r, g, b, 255]
  }
  return [0, 0, 0, 255]
}

/**
 * Converts normalized coordinates [0, 1] to integer pixel coordinates clamped to [0, width - 1] and [0, height - 1].
 * Guarantees that edge coordinates (such as x=0.999 or x=1.0) stay strictly within canvas pixel bounds across any resolution.
 */
export function normalizedToPixel(
  normalizedX: number,
  normalizedY: number,
  width: number,
  height: number
): { x: number; y: number } {
  if (width <= 0 || height <= 0) return { x: 0, y: 0 }
  const clampedNormX = Math.max(0, Math.min(1, Number.isFinite(normalizedX) ? normalizedX : 0))
  const clampedNormY = Math.max(0, Math.min(1, Number.isFinite(normalizedY) ? normalizedY : 0))
  const px = Math.min(width - 1, Math.max(0, Math.round(clampedNormX * width)))
  const py = Math.min(height - 1, Math.max(0, Math.round(clampedNormY * height)))
  return { x: px, y: py }
}


/**
 * Scanline / span-based iterative flood fill algorithm.
 * Avoids unbounded call stack recursion and efficiently fills large regions in O(N) pixel operations.
 *
 * @param image The image data structure with width, height, and RGBA pixel buffer
 * @param startX Starting X coordinate
 * @param startY Starting Y coordinate
 * @param fillColorRgba The target fill color [r, g, b, a]
 * @param tolerance Color matching tolerance (default 32)
 * @returns true if pixels were modified, false if no-op or out-of-bounds
 */
export function floodFill(
  image: ImageDataLike,
  startX: number,
  startY: number,
  fillColorRgba: RgbaColor,
  tolerance = 32
): boolean {
  const { width, height, data } = image
  if (
    startX < 0 ||
    startX >= width ||
    startY < 0 ||
    startY >= height ||
    Number.isNaN(startX) ||
    Number.isNaN(startY)
  ) {
    return false
  }

  const startByteIdx = (startY * width + startX) * 4
  const targetR = data[startByteIdx]
  const targetG = data[startByteIdx + 1]
  const targetB = data[startByteIdx + 2]
  const targetA = data[startByteIdx + 3]

  const [fillR, fillG, fillB, fillA] = fillColorRgba

  // Same-color tap is a no-op
  if (
    Math.abs(targetR - fillR) <= tolerance &&
    Math.abs(targetG - fillG) <= tolerance &&
    Math.abs(targetB - fillB) <= tolerance &&
    Math.abs(targetA - fillA) <= tolerance
  ) {
    return false
  }

  const matchesTarget = (byteIdx: number): boolean => {
    return (
      Math.abs(data[byteIdx] - targetR) <= tolerance &&
      Math.abs(data[byteIdx + 1] - targetG) <= tolerance &&
      Math.abs(data[byteIdx + 2] - targetB) <= tolerance &&
      Math.abs(data[byteIdx + 3] - targetA) <= tolerance
    )
  }

  const visited = new Uint8Array(width * height)
  // Stack of [x, y] coordinates
  const stack: number[] = [startX, startY]

  while (stack.length > 0) {
    const y = stack.pop()!
    const x = stack.pop()!

    const pixelIdx = y * width + x
    if (visited[pixelIdx]) continue

    // Scan left along the line
    let left = x
    while (left > 0) {
      const prevIdx = y * width + (left - 1)
      if (visited[prevIdx] || !matchesTarget(prevIdx * 4)) {
        break
      }
      left--
    }

    // Scan right along the line
    let right = x
    while (right < width - 1) {
      const nextIdx = y * width + (right + 1)
      if (visited[nextIdx] || !matchesTarget(nextIdx * 4)) {
        break
      }
      right++
    }

    // Fill the horizontal span [left, right]
    for (let cx = left; cx <= right; cx++) {
      const cIdx = y * width + cx
      visited[cIdx] = 1
      const byteIdx = cIdx * 4
      data[byteIdx] = fillR
      data[byteIdx + 1] = fillG
      data[byteIdx + 2] = fillB
      data[byteIdx + 3] = fillA
    }

    // Check row above (y - 1) and row below (y + 1)
    const scanRow = (checkY: number) => {
      if (checkY < 0 || checkY >= height) return
      let inSpan = false
      for (let cx = left; cx <= right; cx++) {
        const cIdx = checkY * width + cx
        if (!visited[cIdx] && matchesTarget(cIdx * 4)) {
          if (!inSpan) {
            stack.push(cx, checkY)
            inSpan = true
          }
        } else {
          inSpan = false
        }
      }
    }

    scanRow(y - 1)
    scanRow(y + 1)
  }

  return true
}

/**
 * Helper to run flood fill against a canvas rendering context.
 * Retrieves image data, computes the flood fill, and writes pixels back.
 */
export function executeFloodFillOnCanvas(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  fillColorHex: string,
  tolerance = 32
): boolean {
  const width = ctx.canvas?.width ?? 0
  const height = ctx.canvas?.height ?? 0
  if (width <= 0 || height <= 0) return false
  if (startX < 0 || startX >= width || startY < 0 || startY >= height) return false

  let imageData: ImageData | null = null
  try {
    imageData = ctx.getImageData(0, 0, width, height)
  } catch {
    return false
  }

  if (!imageData || !imageData.data) return false

  const rgba = hexToRgba(fillColorHex)
  const changed = floodFill(imageData, startX, startY, rgba, tolerance)
  if (changed) {
    try {
      ctx.putImageData(imageData, 0, 0)
    } catch {}
  }
  return changed
}
