/**
 * Couche rendu Pixi.js — pure vue, aucune logique de jeu.
 * Lit l'état de simulation et l'affiche.
 *
 * Échelle : SCALE px/m (défini dans spline.js)
 * Route de 7m → 70px à zoom 1.0
 * Coureur (~0.5m de large) → sprite de ~8px au zoom neutre
 */
import * as PIXI from 'pixi.js'
import { riderToPixel, SCALE } from './spline.js'

// Largeur route en mètres → pixels à l'écran (avant zoom)
const ROAD_WIDTH_PX = (w) => w * SCALE

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

    // Container principal zoomable
    this.world = new PIXI.Container()
    this.app.stage.addChild(this.world)

    this.roadContainer  = new PIXI.Container()
    this.riderContainer = new PIXI.Container()
    this.world.addChild(this.roadContainer)
    this.world.addChild(this.riderContainer)

    // Caméra
    this._zoom      = 1.0
    this._targetX   = 0
    this._targetY   = 0
    this._riderSprite = null

    this._setupZoom(canvasEl)
  }

  // ─── Zoom molette ─────────────────────────────────────────────────────────
  _setupZoom(canvas) {
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.1 : 0.91
      this._zoom = Math.max(0.2, Math.min(8.0, this._zoom * factor))
      this.world.scale.set(this._zoom)
    }, { passive: false })
  }

  setZoom(z) {
    this._zoom = Math.max(0.2, Math.min(8.0, z))
    this.world.scale.set(this._zoom)
  }

  // ─── Dessin de la route ───────────────────────────────────────────────────
  drawRoad(spline, segments = []) {
    this.roadContainer.removeChildren()
    this._spline = spline

    // Construction d'une lookup table largeur par position
    this._segmentWidths = segments  // [{from, to, road_width_m}]

    const gfxShadow  = new PIXI.Graphics()
    const gfxRoad    = new PIXI.Graphics()
    const gfxCenter  = new PIXI.Graphics()
    const gfxBorders = new PIXI.Graphics()

    const SAMPLES = Math.ceil(spline.totalLength / 5)  // 1 point tous les 5m
    const step    = spline.totalLength / SAMPLES

    // Ombre
    gfxShadow.lineStyle(ROAD_WIDTH_PX(8) + 6, 0x000000, 0.25)
    for (let i = 0; i <= SAMPLES; i++) {
      const pt = spline.getPoint(i * step)
      if (i === 0) gfxShadow.moveTo(pt.x + 3, pt.y + 4)
      else gfxShadow.lineTo(pt.x + 3, pt.y + 4)
    }

    // Route avec couleur selon gradient
    let prevGrad = null
    for (let i = 0; i <= SAMPLES; i++) {
      const pos  = i * step
      const pt   = spline.getPoint(pos)
      const grad = spline.getGradientAt(pos)
      const roadW = this._getRoadWidthAt(pos, segments)
      const color = this._gradientColor(grad)

      if (color !== prevGrad || i === 0) {
        if (i > 0) gfxRoad.lineTo(pt.x, pt.y)
        gfxRoad.lineStyle(ROAD_WIDTH_PX(roadW), color, 1)
        gfxRoad.moveTo(pt.x, pt.y)
        prevGrad = color
      } else {
        gfxRoad.lineTo(pt.x, pt.y)
      }
    }

    // Bordures blanches (lignes latérales)
    gfxBorders.lineStyle(1.5, 0xffffff, 0.25)
    for (let side of [-1, 1]) {
      for (let i = 0; i <= SAMPLES; i++) {
        const pos    = i * step
        const pt     = spline.getPoint(pos)
        const tan    = spline.getTangent(pos)
        const perp   = { x: -tan.y, y: tan.x }
        const roadW  = this._getRoadWidthAt(pos, segments)
        const hw     = ROAD_WIDTH_PX(roadW) / 2
        const bx     = pt.x + perp.x * hw * side
        const by     = pt.y + perp.y * hw * side
        if (i === 0) gfxBorders.moveTo(bx, by)
        else gfxBorders.lineTo(bx, by)
      }
    }

    // Ligne centrale pointillée
    let dashOn = true
    let dashAcc = 0
    const DASH = 8, GAP = 6
    gfxCenter.lineStyle(1, 0xffffff, 0.15)
    for (let i = 0; i <= SAMPLES; i++) {
      const pos = i * step
      const pt  = spline.getPoint(pos)
      if (i === 0) { gfxCenter.moveTo(pt.x, pt.y); continue }
      dashAcc += step
      if (dashOn && dashAcc >= DASH) { dashOn = false; dashAcc = 0; gfxCenter.moveTo(pt.x, pt.y) }
      else if (!dashOn && dashAcc >= GAP) { dashOn = true; dashAcc = 0; gfxCenter.moveTo(pt.x, pt.y) }
      else if (dashOn) { gfxCenter.lineTo(pt.x, pt.y) }
      else { gfxCenter.moveTo(pt.x, pt.y) }
    }

    this.roadContainer.addChild(gfxShadow)
    this.roadContainer.addChild(gfxRoad)
    this.roadContainer.addChild(gfxBorders)
    this.roadContainer.addChild(gfxCenter)

    this._drawKmMarkers(spline)
  }

  _getRoadWidthAt(splinePos, segments) {
    for (const seg of segments) {
      if (splinePos >= seg.from && splinePos <= seg.to) return seg.road_width_m
    }
    return 7
  }

  _drawKmMarkers(spline) {
    const totalKm = spline.rawPoints[spline.rawPoints.length - 1].km
    for (let km = 1; km <= Math.floor(totalKm); km++) {
      // Trouver la splinePos correspondant à ce km
      const table = spline._altTable
      let pos = 0
      for (let i = 0; i < table.length - 1; i++) {
        if (km >= table[i].km && km <= table[i+1].km) {
          const t = (km - table[i].km) / (table[i+1].km - table[i].km)
          pos = table[i].splinePos + t * (table[i+1].splinePos - table[i].splinePos)
          break
        }
      }
      const pt  = spline.getPoint(pos)
      const tan = spline.getTangent(pos)
      const perp = { x: -tan.y, y: tan.x }

      const marker = new PIXI.Graphics()
      marker.lineStyle(2, 0xffffff, 0.4)
      marker.moveTo(pt.x + perp.x * 40, pt.y + perp.y * 40)
      marker.lineTo(pt.x - perp.x * 40, pt.y - perp.y * 40)

      const text = new PIXI.Text(`${km}km`, {
        fontSize: 14, fill: 0xffffff, alpha: 0.7,
      })
      text.x = pt.x + perp.x * 50
      text.y = pt.y + perp.y * 50
      text.anchor.set(0.5)

      this.roadContainer.addChild(marker)
      this.roadContainer.addChild(text)
    }
  }

  // ─── Coureur ──────────────────────────────────────────────────────────────
  initRider(rider) {
    if (this._riderSprite) this.riderContainer.removeChild(this._riderSprite)

    const gfx = new PIXI.Graphics()
    this._riderSprite = gfx
    this.riderContainer.addChild(gfx)
    this._drawRiderShape(gfx, 1)  // zone Z1 par défaut
  }

  _drawRiderShape(gfx, zone) {
    const zoneColors = {
      1: 0x60a5fa, 2: 0x34d399, 3: 0xfbbf24,
      4: 0xf97316, 5: 0xef4444, 6: 0xdc2626,
    }
    const color = zoneColors[zone] ?? 0x60a5fa

    // Tailles en pixels (à SCALE=10, 1m = 10px)
    // Coureur réel : ~0.5m large, ~1.0m long (avec vélo)
    // A l'écran à SCALE=10 : ~5px × 10px — trop petit au zoom 1.0
    // On utilise une taille visuelle fixe indépendante du SCALE
    // pour rester lisible : environ 12px × 20px

    const W = 10  // demi-largeur
    const L = 16  // demi-longueur

    gfx.clear()

    // Halo effort
    gfx.beginFill(color, 0.18)
    gfx.drawEllipse(0, 0, W + 8, L + 8)
    gfx.endFill()

    // Corps vélo (ellipse orientée avant/arrière)
    gfx.beginFill(0xe53e3e)
    gfx.drawEllipse(0, 0, W, L)
    gfx.endFill()

    // Tête (cercle blanc petit)
    gfx.beginFill(0xffffff, 0.9)
    gfx.drawCircle(0, -L + 4, 4)
    gfx.endFill()

    // Couleur du halo selon zone
    gfx.lineStyle(1.5, color, 0.8)
    gfx.drawEllipse(0, 0, W, L)
  }

  // ─── Update frame (60 FPS) ────────────────────────────────────────────────
  /**
   * Appelé à chaque frame via requestAnimationFrame.
   * Utilise rider.renderPos (interpolé) pour la position visuelle.
   */
  updateRider(rider, spline) {
    if (!this._riderSprite || !spline) return

    // Utilise renderPos pour le rendu fluide
    const posForRender = rider.renderPos ?? rider.splinePos
    const renderRider  = { ...rider, splinePos: posForRender }

    const roadW = this._segments
      ? this._getRoadWidthAt(posForRender, this._segmentWidths ?? [])
      : 7

    const px = riderToPixel(renderRider, spline, roadW)

    // Lerp position (smooth)
    this._riderSprite.x += (px.x - this._riderSprite.x) * 0.25
    this._riderSprite.y += (px.y - this._riderSprite.y) * 0.25
    this._riderSprite.rotation = px.rotation + Math.PI / 2  // ellipse orientée "vers l'avant"

    // Redessiner avec la bonne couleur de zone
    this._drawRiderShape(this._riderSprite, rider.energy.zone)

    // Caméra suit le coureur (lerp sur position réelle px)
    this._followCamera(px)
  }

  _followCamera(riderPx) {
    const w = this.app.screen.width
    const h = this.app.screen.height

    // On veut que riderPx * zoom soit au centre de l'écran
    const targetX = w / 2 - riderPx.x * this._zoom
    const targetY = h / 2 - riderPx.y * this._zoom

    this.world.x += (targetX - this.world.x) * 0.07
    this.world.y += (targetY - this.world.y) * 0.07
  }

  _gradientColor(gradient) {
    if (gradient > 8)  return 0x7c3aed   // violet — HC
    if (gradient > 5)  return 0xef4444   // rouge — montagne
    if (gradient > 2)  return 0xf97316   // orange — côte
    if (gradient > 0)  return 0xfbbf24   // jaune — faux-plat
    if (gradient < -3) return 0x60a5fa   // bleu — descente
    return 0x4a5568                       // gris — plat
  }

  destroy() {
    this.app.destroy(false)
  }
}
