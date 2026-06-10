/**
 * Spline Catmull-Rom — Vélo Manager / Rider
 *
 * IMPORTANT — système de coordonnées :
 *   Les points JSON sont en MÈTRES (x, y, alt, km).
 *   La spline travaille en mètres, et expose splinePos en mètres.
 *   La conversion mètres → pixels est faite uniquement par riderToPixel
 *   via le paramètre SCALE (pixels par mètre).
 *
 *   Valeur de référence : SCALE = 10 px/m
 *   => une route de 7m de large = 70 px à l'écran (zoom 1.0)
 *   => le coureur (~0.5m de large) = 5 px → visible et à l'échelle
 */

export const SCALE = 10 // pixels par mètre — ajuster selon les besoins visuels

export class CatmullRomSpline {
  /**
   * @param {Array} points - [{x, y, alt, km}, ...] en mètres
   */
  constructor(points) {
    this.rawPoints = points
    this._segments = []
    this._kmTable  = []   // table splinePos (m) → km réel → alt interpolée
    this._build()
  }

  _build() {
    const pts = this.rawPoints
    if (pts.length < 2) return

    let totalLength = 0
    this._segments = []

    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[Math.min(pts.length - 1, i + 2)]

      // Longueur du segment (en mètres) par échantillonnage
      let segLen = 0
      const samples = 40
      let prev = this._catmullRom(p0, p1, p2, p3, 0)
      for (let s = 1; s <= samples; s++) {
        const t = s / samples
        const curr = this._catmullRom(p0, p1, p2, p3, t)
        // distance en mètres (coords en mètres → direct)
        segLen += Math.hypot(curr.x - prev.x, curr.y - prev.y)
        prev = curr
      }

      this._segments.push({
        p0, p1, p2, p3,
        startDist: totalLength,  // en mètres
        length: segLen,          // en mètres
      })
      totalLength += segLen
    }

    this.totalLength = totalLength  // en mètres
    this._buildKmTable()
  }

  /**
   * Table de correspondance splinePos (m) → altitude (m)
   * Interpolée depuis les km déclarés dans le JSON.
   */
  _buildKmTable() {
    const pts = this.rawPoints
    const totalKm = pts[pts.length - 1].km

    // Pour chaque point de contrôle, on calcule sa splinePos approchée
    // en utilisant le ratio km/totalKm * totalLength
    this._altTable = pts.map(p => ({
      splinePos: (p.km / totalKm) * this.totalLength,
      alt: p.alt,
      km: p.km,
    }))
  }

  /**
   * Altitude interpolée à une position spline donnée.
   */
  getAltAt(splinePos) {
    const table = this._altTable
    if (!table || table.length < 2) return 0

    // Trouver les deux points encadrants
    let i = table.length - 2
    for (let j = 0; j < table.length - 1; j++) {
      if (splinePos <= table[j + 1].splinePos) { i = j; break }
    }

    const a = table[i]
    const b = table[i + 1]
    const range = b.splinePos - a.splinePos
    if (range <= 0) return a.alt

    const t = (splinePos - a.splinePos) / range
    return a.alt + (b.alt - a.alt) * t
  }

  /**
   * Gradient en % à une position donnée.
   * Calculé depuis l'altitude réelle (mètres) / distance réelle (mètres).
   */
  getGradientAt(splinePos) {
    const delta = 50 // 50 mètres d'échantillonnage
    const posA = Math.max(0, splinePos - delta / 2)
    const posB = Math.min(this.totalLength, splinePos + delta / 2)
    const altA = this.getAltAt(posA)
    const altB = this.getAltAt(posB)
    const dist = posB - posA
    if (dist === 0) return 0
    return ((altB - altA) / dist) * 100  // en %
  }

  /**
   * Km parcourus à une position spline donnée.
   */
  getKmAt(splinePos) {
    const table = this._altTable
    if (!table || table.length < 2) return 0
    let i = table.length - 2
    for (let j = 0; j < table.length - 1; j++) {
      if (splinePos <= table[j + 1].splinePos) { i = j; break }
    }
    const a = table[i]
    const b = table[i + 1]
    const range = b.splinePos - a.splinePos
    if (range <= 0) return a.km
    const t = (splinePos - a.splinePos) / range
    return a.km + (b.km - a.km) * t
  }

  /**
   * Position pixel pour une position spline en mètres.
   * Applique SCALE pour la conversion.
   * @returns {{ x, y }} en pixels
   */
  getPoint(splinePos) {
    const seg = this._getSegment(splinePos)
    if (!seg) {
      const last = this.rawPoints[this.rawPoints.length - 1]
      return { x: last.x * SCALE, y: last.y * SCALE }
    }
    const t = Math.min(1, (splinePos - seg.startDist) / seg.length)
    const pt = this._catmullRom(seg.p0, seg.p1, seg.p2, seg.p3, t)
    return { x: pt.x * SCALE, y: pt.y * SCALE }
  }

  /**
   * Tangente normalisée à une position donnée.
   */
  getTangent(splinePos) {
    const eps = 1.0  // 1 mètre
    const a = this.getPoint(Math.max(0, splinePos - eps))
    const b = this.getPoint(Math.min(this.totalLength, splinePos + eps))
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    return { x: dx / len, y: dy / len }
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
}

/**
 * riderToPixel — interface canonique splinePos/lateralOffset → pixels.
 * Conforme TDD §5.3.
 *
 * @param {Object} rider  - {splinePos, lateralOffset}
 * @param {CatmullRomSpline} spline
 * @param {number} roadWidthM - largeur de route en mètres
 * @returns {{ x, y, rotation }} en pixels
 */
export function riderToPixel(rider, spline, roadWidthM = 7) {
  const point   = spline.getPoint(rider.splinePos)
  const tangent = spline.getTangent(rider.splinePos)
  const perp    = { x: -tangent.y, y: tangent.x }
  const hw      = (roadWidthM * SCALE) / 2
  const offset  = Math.max(-hw, Math.min(hw, rider.lateralOffset * SCALE))
  return {
    x: point.x + perp.x * offset,
    y: point.y + perp.y * offset,
    rotation: Math.atan2(tangent.y, tangent.x),
  }
}
