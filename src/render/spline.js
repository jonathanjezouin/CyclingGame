/**
 * Spline Catmull-Rom générée depuis les points JSON du tracé.
 * Expose : getPoint(t), getTangent(t), getGradientAt(splinePos), totalLength.
 */

export class CatmullRomSpline {
  /**
   * @param {Array} points - [{x, y, alt, km}, ...]
   */
  constructor(points) {
    this.rawPoints = points
    this._segments = []
    this._build()
  }

  _build() {
    const pts = this.rawPoints
    if (pts.length < 2) return

    // Calcul des longueurs de segments par échantillonnage
    let totalLength = 0
    this._segments = []

    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[Math.min(pts.length - 1, i + 2)]

      // Longueur approx par échantillonnage
      let segLen = 0
      const samples = 20
      let prev = this._catmullRom(p0, p1, p2, p3, 0)
      for (let s = 1; s <= samples; s++) {
        const t = s / samples
        const curr = this._catmullRom(p0, p1, p2, p3, t)
        segLen += Math.hypot(curr.x - prev.x, curr.y - prev.y)
        prev = curr
      }

      this._segments.push({
        p0, p1, p2, p3,
        startDist: totalLength,
        length: segLen,
      })
      totalLength += segLen
    }

    this.totalLength = totalLength
  }

  /**
   * Position pixel pour une position sur la spline (mètres).
   * @returns {{ x, y }}
   */
  getPoint(splinePos) {
    const seg = this._getSegment(splinePos)
    if (!seg) return this._ptToXY(this.rawPoints[this.rawPoints.length - 1])
    const t = (splinePos - seg.startDist) / seg.length
    return this._catmullRom(seg.p0, seg.p1, seg.p2, seg.p3, t)
  }

  /**
   * Tangente normalisée à une position donnée.
   * @returns {{ x, y }}
   */
  getTangent(splinePos) {
    const eps = 0.5
    const a = this.getPoint(Math.max(0, splinePos - eps))
    const b = this.getPoint(Math.min(this.totalLength, splinePos + eps))
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    return { x: dx / len, y: dy / len }
  }

  /**
   * Gradient en % à une position donnée (interpolé depuis alt).
   */
  getGradientAt(splinePos) {
    const seg = this._getSegment(splinePos)
    if (!seg) return 0
    const t = (splinePos - seg.startDist) / seg.length
    const altStart = seg.p1.alt ?? 0
    const altEnd = seg.p2.alt ?? 0
    const altCurr = altStart + (altEnd - altStart) * t
    const altNext = altStart + (altEnd - altStart) * Math.min(1, t + 0.05)
    const distNext = seg.length * 0.05
    if (distNext === 0) return 0
    return ((altNext - altCurr) / distNext) * 100
  }

  _getSegment(splinePos) {
    const pos = Math.max(0, Math.min(splinePos, this.totalLength))
    for (let i = this._segments.length - 1; i >= 0; i--) {
      if (pos >= this._segments[i].startDist) return this._segments[i]
    }
    return this._segments[0]
  }

  _catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t
    const t3 = t2 * t
    return {
      x: 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      ),
      y: 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      ),
    }
  }

  _ptToXY(p) {
    return { x: p.x, y: p.y }
  }
}

/**
 * riderToPixel — interface canonique splinePos/lateralOffset → pixel.
 * Conforme TDD §5.3.
 */
export function riderToPixel(rider, spline, roadWidthAtPos = 8) {
  const point = spline.getPoint(rider.splinePos)
  const tangent = spline.getTangent(rider.splinePos)
  const perp = { x: -tangent.y, y: tangent.x }
  const hw = roadWidthAtPos / 2
  const offset = Math.max(-hw, Math.min(hw, rider.lateralOffset))
  return {
    x: point.x + perp.x * offset,
    y: point.y + perp.y * offset,
    rotation: Math.atan2(tangent.y, tangent.x),
  }
}
