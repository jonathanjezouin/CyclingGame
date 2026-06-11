/**
 * Couche rendu Pixi.js — pure vue, aucune logique de jeu.
 *
 * Échelle : SCALE px/m (défini dans spline.js), actuellement 10 px/m.
 * Route uniforme : ROAD_WIDTH_M = 7m → 70px à zoom 1.0.
 * Coureur à l'échelle réelle : ~1.8m long × 0.5m large → 18×5px à zoom 1.0.
 * Halo léger pour lisibilité au zoom éloigné.
 */
import * as PIXI from 'pixi.js'
import { riderToPixel, SCALE } from './spline.js'

const ROAD_WIDTH_M  = 7                   // largeur uniforme en mètres
const ROAD_WIDTH_PX = ROAD_WIDTH_M * SCALE // 70px à zoom 1.0

// Dimensions sprite en pixels (à l'échelle)
const RIDER_LENGTH_M = 1.9   // longueur vélo+coureur (m)
const RIDER_WIDTH_M  = 0.75  // largeur guidon compris (m) — légèrement majorée pour lisibilité

export class GameRenderer {
  constructor(canvasEl) {
    this.app = new PIXI.Application({
      view: canvasEl,
      resizeTo: canvasEl.parentElement,
      backgroundColor: 0x1a1a2e,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })

    this.world          = new PIXI.Container()
    this.roadContainer  = new PIXI.Container()
    this.riderContainer = new PIXI.Container()
    this.world.addChild(this.roadContainer)
    this.world.addChild(this.riderContainer)
    this.app.stage.addChild(this.world)

    this._zoom    = 1.0
    this._sprites = new Map()   // riderId → PIXI.Graphics

    this._setupZoom(canvasEl)
  }

  // ─── Zoom molette ──────────────────────────────────────────────────────────
  _setupZoom(canvas) {
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.1 : 0.91
      this._zoom = Math.max(0.2, Math.min(8.0, this._zoom * factor))
      this.world.scale.set(this._zoom)
    }, { passive: false })
  }

  // ─── Route (largeur uniforme) ──────────────────────────────────────────────
  drawRoad(spline) {
    this.roadContainer.removeChildren()
    this._spline = spline

    const SAMPLES = Math.ceil(spline.totalLength / 5)
    const step    = spline.totalLength / SAMPLES

    const gfxShadow  = new PIXI.Graphics()
    const gfxRoad    = new PIXI.Graphics()
    const gfxBorders = new PIXI.Graphics()
    const gfxCenter  = new PIXI.Graphics()

    // Ombre portée
    gfxShadow.lineStyle(ROAD_WIDTH_PX + 6, 0x000000, 0.22)
    for (let i = 0; i <= SAMPLES; i++) {
      const pt = spline.getPoint(i * step)
      if (i === 0) gfxShadow.moveTo(pt.x + 2, pt.y + 3)
      else gfxShadow.lineTo(pt.x + 2, pt.y + 3)
    }

    // Asphalte coloré selon gradient
    let prevColor = null
    for (let i = 0; i <= SAMPLES; i++) {
      const pos   = i * step
      const pt    = spline.getPoint(pos)
      const color = this._gradientColor(spline.getGradientAt(pos))
      if (color !== prevColor || i === 0) {
        if (i > 0) gfxRoad.lineTo(pt.x, pt.y)
        gfxRoad.lineStyle(ROAD_WIDTH_PX, color, 1)
        gfxRoad.moveTo(pt.x, pt.y)
        prevColor = color
      } else {
        gfxRoad.lineTo(pt.x, pt.y)
      }
    }

    // Bordures latérales blanches
    gfxBorders.lineStyle(1.5, 0xffffff, 0.3)
    for (const side of [-1, 1]) {
      for (let i = 0; i <= SAMPLES; i++) {
        const pos  = i * step
        const pt   = spline.getPoint(pos)
        const tan  = spline.getTangent(pos)
        const perp = { x: -tan.y, y: tan.x }
        const hw   = ROAD_WIDTH_PX / 2
        const bx   = pt.x + perp.x * hw * side
        const by   = pt.y + perp.y * hw * side
        if (i === 0) gfxBorders.moveTo(bx, by)
        else gfxBorders.lineTo(bx, by)
      }
    }

    // Ligne centrale pointillée
    gfxCenter.lineStyle(1, 0xffffff, 0.12)
    let dashOn = true, dashAcc = 0
    const DASH = 10, GAP = 8
    for (let i = 0; i <= SAMPLES; i++) {
      const pt = spline.getPoint(i * step)
      if (i === 0) { gfxCenter.moveTo(pt.x, pt.y); continue }
      dashAcc += step
      if (dashOn && dashAcc >= DASH)       { dashOn = false; dashAcc = 0; gfxCenter.moveTo(pt.x, pt.y) }
      else if (!dashOn && dashAcc >= GAP)  { dashOn = true;  dashAcc = 0; gfxCenter.moveTo(pt.x, pt.y) }
      else if (dashOn)                     { gfxCenter.lineTo(pt.x, pt.y) }
      else                                 { gfxCenter.moveTo(pt.x, pt.y) }
    }

    this.roadContainer.addChild(gfxShadow)
    this.roadContainer.addChild(gfxRoad)
    this.roadContainer.addChild(gfxBorders)
    this.roadContainer.addChild(gfxCenter)
    this._drawKmMarkers(spline)
  }

  _drawKmMarkers(spline) {
    const table  = spline._altTable
    const totalKm = spline.rawPoints[spline.rawPoints.length - 1].km
    for (let km = 1; km <= Math.floor(totalKm); km++) {
      let pos = 0
      for (let i = 0; i < table.length - 1; i++) {
        if (km >= table[i].km && km <= table[i+1].km) {
          const t = (km - table[i].km) / (table[i+1].km - table[i].km)
          pos = table[i].splinePos + t * (table[i+1].splinePos - table[i].splinePos)
          break
        }
      }
      const pt   = spline.getPoint(pos)
      const tan  = spline.getTangent(pos)
      const perp = { x: -tan.y, y: tan.x }
      const hw   = ROAD_WIDTH_PX / 2 + 6

      const gfx = new PIXI.Graphics()
      gfx.lineStyle(1.5, 0xffffff, 0.35)
      gfx.moveTo(pt.x + perp.x * hw, pt.y + perp.y * hw)
      gfx.lineTo(pt.x - perp.x * hw, pt.y - perp.y * hw)

      const text = new PIXI.Text(`${km}`, { fontSize: 12, fill: 0xffffff, alpha: 0.5 })
      text.x = pt.x + perp.x * (hw + 10)
      text.y = pt.y + perp.y * (hw + 10)
      text.anchor.set(0.5)

      this.roadContainer.addChild(gfx)
      this.roadContainer.addChild(text)
    }
  }

  // ─── Coureurs — API multi-riders ───────────────────────────────────────────

  /**
   * Initialise les sprites pour une liste de coureurs.
   * @param {Array} riders - [{id, isPlayer, color}, ...]
   */
  initRiders(riders) {
    this.riderContainer.removeChildren()
    this._sprites.clear()
    for (const rider of riders) {
      const gfx = new PIXI.Graphics()
      this.riderContainer.addChild(gfx)
      this._sprites.set(rider.id, { gfx, prevX: 0, prevY: 0 })
    }
  }

  /**
   * Met à jour la position et l'apparence de tous les coureurs.
   * Appelé à 60 FPS depuis App.vue.
   * @param {Array} riders - état complet des coureurs
   * @param {Object} spline
   * @param {string} playerRiderId - id du coureur suivi par la caméra
   */
  updateRiders(riders, spline, playerRiderId) {
    if (!spline) return

    let playerPx = null

    for (const rider of riders) {
      const entry = this._sprites.get(rider.id)
      if (!entry) continue

      const posForRender = rider.renderPos ?? rider.splinePos
      const renderRider  = { ...rider, splinePos: posForRender }
      const px = riderToPixel(renderRider, spline, ROAD_WIDTH_M)

      // Lerp visuel
      entry.gfx.x += (px.x - entry.gfx.x) * 0.25
      entry.gfx.y += (px.y - entry.gfx.y) * 0.25
      entry.gfx.rotation = px.rotation + Math.PI / 2

      this._drawRiderShape(entry.gfx, rider)

      if (rider.id === playerRiderId) playerPx = px
    }

    if (playerPx) this._followCamera(playerPx)
  }

  /**
   * Dessine la forme d'un coureur à l'échelle réelle.
   * Taille en pixels = dimensions en mètres × SCALE.
   *   Longueur : 1.8m → 18px
   *   Largeur  : 0.5m → 5px
   * Le halo est ~2× la taille du corps pour rester visible au zoom éloigné.
   */
  _drawRiderShape(gfx, rider) {
    const zoneColors = {
      1: 0x60a5fa, 2: 0x34d399, 3: 0xfbbf24,
      4: 0xf97316, 5: 0xef4444, 6: 0xdc2626,
    }
    const zone      = rider.energy?.zone ?? 2
    const zoneColor = zoneColors[zone] ?? 0x60a5fa
    const bodyColor = rider.isPlayer ? 0xe53e3e : 0x3b82f6

    // Dimensions à l'échelle
    const hl = (RIDER_LENGTH_M * SCALE) / 2   // demi-longueur px = 9
    const hw = (RIDER_WIDTH_M  * SCALE) / 2   // demi-largeur px  = 2.5

    gfx.clear()

    // Halo effort (2× le corps)
    gfx.beginFill(zoneColor, 0.15)
    gfx.drawEllipse(0, 0, hw * 2, hl * 2)
    gfx.endFill()

    // Corps vélo
    gfx.beginFill(bodyColor, 0.9)
    gfx.drawEllipse(0, 0, hw, hl)
    gfx.endFill()

    // Outline zone
    gfx.lineStyle(0.8, zoneColor, 0.7)
    gfx.drawEllipse(0, 0, hw, hl)
  }

  // ─── Caméra ────────────────────────────────────────────────────────────────
  _followCamera(riderPx) {
    const w = this.app.screen.width
    const h = this.app.screen.height
    const targetX = w / 2 - riderPx.x * this._zoom
    const targetY = h / 2 - riderPx.y * this._zoom
    this.world.x += (targetX - this.world.x) * 0.07
    this.world.y += (targetY - this.world.y) * 0.07
  }

  _gradientColor(gradient) {
    if (gradient > 8)  return 0x7c3aed
    if (gradient > 5)  return 0xef4444
    if (gradient > 2)  return 0xf97316
    if (gradient > 0)  return 0xfbbf24
    if (gradient < -3) return 0x60a5fa
    return 0x4a5568
  }

  destroy() {
    this.app.destroy(false)
  }
}
