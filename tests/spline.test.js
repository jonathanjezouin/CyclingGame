import { describe, it, expect } from 'vitest'
import { CatmullRomSpline, riderToPixel, SCALE } from '../src/render/spline.js'

// Tracé simple : ligne droite montante régulière.
// 1000 m horizontaux, +50 m de dénivelé → ~5% de pente moyenne.
const straightClimb = [
  { x: 0,    y: 0, alt: 100, km: 0.0 },
  { x: 250,  y: 0, alt: 112.5, km: 0.25 },
  { x: 500,  y: 0, alt: 125, km: 0.5 },
  { x: 750,  y: 0, alt: 137.5, km: 0.75 },
  { x: 1000, y: 0, alt: 150, km: 1.0 },
]

describe('CatmullRomSpline — construction', () => {
  const s = new CatmullRomSpline(straightClimb)

  it('totalLength proche de la distance réelle (1000 m)', () => {
    expect(s.totalLength).toBeGreaterThan(950)
    expect(s.totalLength).toBeLessThan(1050)
  })

  it('getPoint au départ ≈ origine (en pixels)', () => {
    const p = s.getPoint(0)
    expect(Math.abs(p.x)).toBeLessThan(SCALE)       // ~0
    expect(Math.abs(p.y)).toBeLessThan(SCALE)
  })

  it('getPoint progresse en x avec splinePos', () => {
    expect(s.getPoint(500).x).toBeGreaterThan(s.getPoint(100).x)
  })

  it('getPoint convertit bien en pixels (x ≈ mètres × SCALE)', () => {
    // à mi-parcours (~500 m), x pixel ≈ 500 × SCALE
    const p = s.getPoint(s.totalLength / 2)
    expect(p.x).toBeGreaterThan(400 * SCALE)
    expect(p.x).toBeLessThan(600 * SCALE)
  })
})

describe('CatmullRomSpline — altitude & gradient', () => {
  const s = new CatmullRomSpline(straightClimb)

  it('getAltAt croît du départ à l\'arrivée', () => {
    expect(s.getAltAt(0)).toBeCloseTo(100, 0)
    expect(s.getAltAt(s.totalLength)).toBeGreaterThan(145)
  })

  it('gradient ≈ +5% sur la montée régulière', () => {
    const g = s.getGradientAt(s.totalLength / 2)
    expect(g).toBeGreaterThan(3)
    expect(g).toBeLessThan(7)
  })

  it('gradient négatif sur une descente', () => {
    const descent = straightClimb.map((p, i) => ({
      ...p, alt: 150 - (p.alt - 100),
    }))
    const sd = new CatmullRomSpline(descent)
    expect(sd.getGradientAt(sd.totalLength / 2)).toBeLessThan(0)
  })

  it('gradient ≈ 0 sur le plat', () => {
    const flat = straightClimb.map(p => ({ ...p, alt: 100 }))
    const sf = new CatmullRomSpline(flat)
    expect(Math.abs(sf.getGradientAt(sf.totalLength / 2))).toBeLessThan(0.5)
  })
})

describe('CatmullRomSpline — getKmAt', () => {
  const s = new CatmullRomSpline(straightClimb)

  it('km = 0 au départ', () => {
    expect(s.getKmAt(0)).toBeCloseTo(0, 1)
  })

  it('km croissant et borné par le total', () => {
    expect(s.getKmAt(s.totalLength)).toBeGreaterThan(0.9)
    expect(s.getKmAt(s.totalLength)).toBeLessThanOrEqual(1.01)
  })

  it('monotone', () => {
    expect(s.getKmAt(s.totalLength * 0.75)).toBeGreaterThan(s.getKmAt(s.totalLength * 0.25))
  })
})

describe('CatmullRomSpline — getSplinePosAtKm (IA0, conversion keyPoints)', () => {
  const s = new CatmullRomSpline(straightClimb)

  it('km = 0 → splinePos = 0', () => {
    expect(s.getSplinePosAtKm(0)).toBeCloseTo(0, 3)
  })

  it('km total → splinePos = totalLength', () => {
    expect(s.getSplinePosAtKm(1.0)).toBeCloseTo(s.totalLength, 3)
  })

  it('km à mi-parcours (point de contrôle exact) → ≈ totalLength / 2', () => {
    expect(s.getSplinePosAtKm(0.5)).toBeCloseTo(s.totalLength / 2, 3)
  })

  it('round-trip avec getKmAt', () => {
    const pos = s.totalLength * 0.3
    const km  = s.getKmAt(pos)
    expect(s.getSplinePosAtKm(km)).toBeCloseTo(pos, 1)
  })

  it('monotone', () => {
    expect(s.getSplinePosAtKm(0.75)).toBeGreaterThan(s.getSplinePosAtKm(0.25))
  })
})

describe('riderToPixel — interface canonique TDD §5.3', () => {
  const s = new CatmullRomSpline(straightClimb)

  it('lateralOffset = 0 → sur l\'axe de la route', () => {
    const onAxis = s.getPoint(500)
    const px = riderToPixel({ splinePos: 500, lateralOffset: 0 }, s)
    expect(Math.abs(px.x - onAxis.x)).toBeLessThan(0.01)
    expect(Math.abs(px.y - onAxis.y)).toBeLessThan(0.01)
  })

  it('offsets opposés → de part et d\'autre de l\'axe', () => {
    const left  = riderToPixel({ splinePos: 500, lateralOffset: -0.8 }, s)
    const right = riderToPixel({ splinePos: 500, lateralOffset:  0.8 }, s)
    // route horizontale → décalage latéral sur l'axe y
    expect(Math.sign(left.y - right.y)).not.toBe(0)
    expect(left.y).not.toBeCloseTo(right.y, 1)
  })

  it('clip à la demi-largeur de route', () => {
    // offset énorme (50 m) sur une route de 7 m → bridé à hw = 3.5 m
    const px = riderToPixel({ splinePos: 500, lateralOffset: 50 }, s, 7)
    const axis = s.getPoint(500)
    const dist = Math.hypot(px.x - axis.x, px.y - axis.y)
    const hwPx = (7 * SCALE) / 2
    expect(dist).toBeLessThanOrEqual(hwPx + 0.01)
  })

  it('retourne une rotation (tangente)', () => {
    const px = riderToPixel({ splinePos: 500, lateralOffset: 0 }, s)
    expect(Number.isFinite(px.rotation)).toBe(true)
    // route vers +x → rotation ≈ 0
    expect(Math.abs(px.rotation)).toBeLessThan(0.2)
  })
})
