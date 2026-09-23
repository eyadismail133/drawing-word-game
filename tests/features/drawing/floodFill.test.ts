import { describe, expect, it } from 'vitest'
import {
  floodFill,
  hexToRgba,
  normalizedToPixel,
  type ImageDataLike,
} from '../../../src/features/drawing/floodFill'

function createTestImage(
  width: number,
  height: number,
  fillColor: [number, number, number, number] = [255, 255, 255, 255]
): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fillColor[0]
    data[i + 1] = fillColor[1]
    data[i + 2] = fillColor[2]
    data[i + 3] = fillColor[3]
  }
  return { width, height, data }
}

function getPixel(image: ImageDataLike, x: number, y: number): [number, number, number, number] {
  const idx = (y * image.width + x) * 4
  return [image.data[idx], image.data[idx + 1], image.data[idx + 2], image.data[idx + 3]]
}

function setPixel(image: ImageDataLike, x: number, y: number, color: [number, number, number, number]) {
  const idx = (y * image.width + x) * 4
  image.data[idx] = color[0]
  image.data[idx + 1] = color[1]
  image.data[idx + 2] = color[2]
  image.data[idx + 3] = color[3]
}

describe('Flood Fill Algorithm', () => {
  it('correctly parses hex colors to RGBA', () => {
    expect(hexToRgba('#0f172a')).toEqual([15, 23, 42, 255])
    expect(hexToRgba('#3b82f6')).toEqual([59, 130, 246, 255])
    expect(hexToRgba('#ffffff')).toEqual([255, 255, 255, 255])
    expect(hexToRgba('#fff')).toEqual([255, 255, 255, 255])
  })

  it('fills a closed area without leaking outside', () => {
    // 10x10 image with white background
    const image = createTestImage(10, 10, [255, 255, 255, 255])
    const black: [number, number, number, number] = [15, 23, 42, 255]
    const blue: [number, number, number, number] = [59, 130, 246, 255]

    // Draw a closed box boundary from (2,2) to (7,7)
    for (let x = 2; x <= 7; x++) {
      setPixel(image, x, 2, black)
      setPixel(image, x, 7, black)
    }
    for (let y = 2; y <= 7; y++) {
      setPixel(image, 2, y, black)
      setPixel(image, 7, y, black)
    }

    // Interior is (3,3) to (6,6)
    expect(getPixel(image, 4, 4)).toEqual([255, 255, 255, 255])
    expect(getPixel(image, 0, 0)).toEqual([255, 255, 255, 255])

    // Fill inside the closed box at (4, 4) with Blue
    const changed = floodFill(image, 4, 4, blue)
    expect(changed).toBe(true)

    // Interior pixels MUST be Blue
    for (let y = 3; y <= 6; y++) {
      for (let x = 3; x <= 6; x++) {
        expect(getPixel(image, x, y)).toEqual(blue)
      }
    }

    // Boundary pixels MUST remain Black
    expect(getPixel(image, 2, 2)).toEqual(black)
    expect(getPixel(image, 7, 7)).toEqual(black)
    expect(getPixel(image, 2, 5)).toEqual(black)

    // Exterior pixels MUST remain White (no leak!)
    expect(getPixel(image, 0, 0)).toEqual([255, 255, 255, 255])
    expect(getPixel(image, 1, 1)).toEqual([255, 255, 255, 255])
    expect(getPixel(image, 8, 8)).toEqual([255, 255, 255, 255])
    expect(getPixel(image, 9, 9)).toEqual([255, 255, 255, 255])
  })

  it('fills open/background area without invading closed interior', () => {
    const image = createTestImage(10, 10, [255, 255, 255, 255])
    const black: [number, number, number, number] = [15, 23, 42, 255]
    const coral: [number, number, number, number] = [244, 63, 94, 255]

    // Draw closed box boundary
    for (let x = 3; x <= 6; x++) {
      setPixel(image, x, 3, black)
      setPixel(image, x, 6, black)
    }
    for (let y = 3; y <= 6; y++) {
      setPixel(image, 3, y, black)
      setPixel(image, 6, y, black)
    }

    // Fill background at (0, 0) with Coral
    const changed = floodFill(image, 0, 0, coral)
    expect(changed).toBe(true)

    // Outside pixels must be Coral
    expect(getPixel(image, 0, 0)).toEqual(coral)
    expect(getPixel(image, 1, 1)).toEqual(coral)
    expect(getPixel(image, 9, 9)).toEqual(coral)

    // Boundary must remain Black
    expect(getPixel(image, 3, 3)).toEqual(black)

    // Interior must remain White!
    expect(getPixel(image, 4, 4)).toEqual([255, 255, 255, 255])
    expect(getPixel(image, 5, 5)).toEqual([255, 255, 255, 255])
  })

  it('is a no-op when clicking the same color', () => {
    const image = createTestImage(5, 5, [255, 255, 255, 255])
    const white: [number, number, number, number] = [255, 255, 255, 255]

    // Clicking white with white
    const changed = floodFill(image, 2, 2, white)
    expect(changed).toBe(false)
  })

  it('handles boundary cases and out-of-bounds coordinates gracefully', () => {
    const image = createTestImage(5, 5, [255, 255, 255, 255])
    const blue: [number, number, number, number] = [59, 130, 246, 255]

    // Out of bounds coordinates return false
    expect(floodFill(image, -1, 0, blue)).toBe(false)
    expect(floodFill(image, 0, -1, blue)).toBe(false)
    expect(floodFill(image, 5, 2, blue)).toBe(false)
    expect(floodFill(image, 2, 5, blue)).toBe(false)

    // Canvas corners (0,0) and (4,4) are valid
    expect(floodFill(image, 0, 0, blue)).toBe(true)
    expect(getPixel(image, 0, 0)).toEqual(blue)
    expect(getPixel(image, 4, 4)).toEqual(blue)
  })

  it('handles 1x1 image boundary case', () => {
    const image = createTestImage(1, 1, [255, 255, 255, 255])
    const yellow: [number, number, number, number] = [245, 158, 11, 255]
    expect(floodFill(image, 0, 0, yellow)).toBe(true)
    expect(getPixel(image, 0, 0)).toEqual(yellow)
  })

  it('handles large blank region without call stack overflow and within safe time limit', () => {
    // 600x450 canvas resolution (270,000 pixels)
    const image = createTestImage(600, 450, [255, 255, 255, 255])
    const mint: [number, number, number, number] = [16, 185, 129, 255]

    const startTime = performance.now()
    const changed = floodFill(image, 300, 225, mint)
    const elapsed = performance.now() - startTime

    expect(changed).toBe(true)
    expect(elapsed).toBeLessThan(3000) // Non-brittle safe threshold across test environments
    expect(getPixel(image, 0, 0)).toEqual(mint)
    expect(getPixel(image, 599, 449)).toEqual(mint)
  })

  it('correctly clamps normalized coordinates to pixel coordinates across resolutions (P2 edge safety)', () => {
    // Canvas size: 600 x 400
    // Center
    expect(normalizedToPixel(0.5, 0.5, 600, 400)).toEqual({ x: 300, y: 200 })

    // Exact top-left corner
    expect(normalizedToPixel(0, 0, 600, 400)).toEqual({ x: 0, y: 0 })

    // Exact bottom-right corner
    expect(normalizedToPixel(1.0, 1.0, 600, 400)).toEqual({ x: 599, y: 399 })

    // Boundary edge: 0.999 must clamp to max valid pixel [width - 1, height - 1]
    expect(normalizedToPixel(0.999, 0.999, 600, 400)).toEqual({ x: 599, y: 399 })

    // Smaller canvas: 300 x 220
    // Crucial: Math.round(0.999 * 300) = 300, which is out-of-bounds!
    // normalizedToPixel must safely clamp to 299!
    expect(normalizedToPixel(0.999, 0.999, 300, 220)).toEqual({ x: 299, y: 219 })
    expect(normalizedToPixel(1.0, 1.0, 300, 220)).toEqual({ x: 299, y: 219 })

    // Negative or beyond bounds
    expect(normalizedToPixel(-0.5, -0.2, 300, 200)).toEqual({ x: 0, y: 0 })
    expect(normalizedToPixel(1.5, 2.0, 300, 200)).toEqual({ x: 299, y: 199 })
    expect(normalizedToPixel(Number.NaN, Number.NaN, 300, 200)).toEqual({ x: 0, y: 0 })

    // Invalid canvas dimensions return { x: 0, y: 0 }
    expect(normalizedToPixel(0.5, 0.5, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(normalizedToPixel(0.5, 0.5, -100, -100)).toEqual({ x: 0, y: 0 })
  })

  it('respects previously painted regions of different colors', () => {
    const image = createTestImage(10, 10, [255, 255, 255, 255])
    const coral: [number, number, number, number] = [244, 63, 94, 255]
    const purple: [number, number, number, number] = [139, 92, 246, 255]
    const blue: [number, number, number, number] = [59, 130, 246, 255]

    // Paint left half coral
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 5; x++) {
        setPixel(image, x, y, coral)
      }
    }
    // Paint right half purple
    for (let y = 0; y < 10; y++) {
      for (let x = 5; x < 10; x++) {
        setPixel(image, x, y, purple)
      }
    }

    // Fill inside coral region with blue
    const changed = floodFill(image, 2, 2, blue)
    expect(changed).toBe(true)

    // Left half should now be blue
    expect(getPixel(image, 0, 0)).toEqual(blue)
    expect(getPixel(image, 4, 9)).toEqual(blue)

    // Right half MUST remain purple
    expect(getPixel(image, 5, 0)).toEqual(purple)
    expect(getPixel(image, 9, 9)).toEqual(purple)
  })
})
