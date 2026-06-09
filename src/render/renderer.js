/**
 * Couche rendu Pixi.js — pure vue, aucune logique de jeu.
 * Lit l'état de simulation et l'affiche.
 */
import * as PIXI from 'pixi.js'
import { riderToPixel } from './spline.js'

export class GameRenderer {
  constructor(canvasEl) {
    this.app = new PIXI.Application({
      view: canvasEl,
      resizeTo: canvasEl.parentElement,
      backgroundColor: 0x1a1a2e,
      antialias: true,
    })

    this.roadContainer = new PIXI.Container()
    this.riderContainer = new PIXI.Container()
    this.app.stage.addChild(this.roadContainer)
    this.app.stage.addChild(this.riderContainer)

    // Caméra
    this.camera = { x: 0, y: 0, zoom: 1 }

    this._riderSprite = null
    this._riderTrail = []
  }

  /**
   * Dessine la route depuis la spline.
   */
  drawRoad(spline, segments = []) {
    this.roadContainer.removeChildren()
    this._spline = spline

    const roadGfx = new PIXI.Graphics()
    const shadowGfx = new PIXI.Graphics()

    const SAMPLES = Math.ceil(spline.totalLength / 2) // 1 point tous les 2m
    const step = spline.totalLength / SAMPLES

    // Ombre portée
    shadowGfx.lineStyle(14, 0x000000, 0.3)
    for (let i = 0; i <= SAMPLES; i++) {
      const pos = i * step
      const pt = spline.getPoint(pos)
      if (i === 0) shadowGfx.moveTo(pt.x + 3, pt.y + 3)
      else shadowGfx.lineTo(pt.x + 3, pt.y + 3)
    }

    // Route principale
    roadGfx.lineStyle(10, 0x4a5568, 1)
    for (let i = 0; i <= SAMPLES; i++) {
      const pos = i * step
      const pt = spline.getPoint(pos)
      const gradient = spline.getGradientAt(pos)
      // Couleur selon pente
      const color = this._gradientColor(gradient)
      roadGfx.lineStyle(10, color, 1)
      if (i === 0) roadGfx.moveTo(pt.x, pt.y)
      else roadGfx.lineTo(pt.x, pt.y)
    }

    // Ligne centrale pointillée
    const centerGfx = new PIXI.Graphics()
    centerGfx.lineStyle(1, 0xffffff, 0.2)
    for (let i = 0; i <= SAMPLES; i += 2) {
      const pos = i * step
      const pt = spline.getPoint(pos)
      if (i % 4 === 0) centerGfx.moveTo(pt.x, pt.y)
      else centerGfx.lineTo(pt.x, pt.y)
    }

    this.roadContainer.addChild(shadowGfx)
    this.roadContainer.addChild(roadGfx)
    this.roadContainer.addChild(centerGfx)

    // Marqueurs km
    this._drawKmMarkers(spline)
  }

  _drawKmMarkers(spline) {
    const totalKm = spline.totalLength / 1000
    for (let km = 1; km <= Math.floor(totalKm); km++) {
      const pos = km * 1000
      if (pos >= spline.totalLength) break
      const pt = spline.getPoint(pos)
      const tangent = spline.getTangent(pos)
      const perp = { x: -tangent.y, y: tangent.x }

      const marker = new PIXI.Graphics()
      marker.lineStyle(2, 0xffffff, 0.5)
      marker.moveTo(pt.x + perp.x * 8, pt.y + perp.y * 8)
      marker.lineTo(pt.x - perp.x * 8, pt.y - perp.y * 8)

      const text = new PIXI.Text(`${km}km`, {
        fontSize: 10,
        fill: 0xffffff,
        alpha: 0.6,
      })
      text.x = pt.x + perp.x * 12
      text.y = pt.y + perp.y * 12
      text.anchor.set(0.5)

      this.roadContainer.addChild(marker)
      this.roadContainer.addChild(text)
    }
  }

  /**
   * Crée ou met à jour le sprite du coureur.
   */
  initRider(rider) {
    if (this._riderSprite) this.riderContainer.removeChild(this._riderSprite)

    // Sprite placeholder : cercle coloré avec halo
    const gfx = new PIXI.Graphics()

    // Halo d'effort
    gfx.beginFill(0x60a5fa, 0.15)
    gfx.drawCircle(0, 0, 14)
    gfx.endFill()

    // Corps du coureur
    gfx.beginFill(0xe53e3e)
    gfx.drawCircle(0, 0, 7)
    gfx.endFill()

    // Indicateur de direction (petit triangle)
    gfx.beginFill(0xffffff, 0.8)
    gfx.drawPolygon([0, -10, -4, -6, 4, -6])
    gfx.endFill()

    this._riderSprite = gfx
    this._riderHaloGfx = gfx
    this.riderContainer.addChild(this._riderSprite)
  }

  /**
   * Met à jour la position du coureur et la caméra.
   * Appelé à chaque frame (60 FPS) depuis requestAnimationFrame.
   */
  updateRider(rider, spline) {
    if (!this._riderSprite || !spline) return

    const px = riderToPixel(rider, spline, 8)

    // Interpolation douce (lerp) pour le rendu fluide entre ticks
    this._riderSprite.x += (px.x - this._riderSprite.x) * 0.15
    this._riderSprite.y += (px.y - this._riderSprite.y) * 0.15
    this._riderSprite.rotation = px.rotation

    // Couleur halo selon zone d'effort
    this._updateRiderColor(rider.energy.zone)

    // Caméra suit le coureur
    this._followCamera(px)
  }

  _updateRiderColor(zone) {
    const zoneColors = {
      1: 0x60a5fa, 2: 0x34d399, 3: 0xfbbf24,
      4: 0xf97316, 5: 0xef4444, 6: 0xdc2626,
    }
    const color = zoneColors[zone] ?? 0x60a5fa
    this._riderSprite.clear()

    // Halo
    this._riderSprite.beginFill(color, 0.2)
    this._riderSprite.drawCircle(0, 0, 14)
    this._riderSprite.endFill()

    // Corps
    this._riderSprite.beginFill(0xe53e3e)
    this._riderSprite.drawCircle(0, 0, 7)
    this._riderSprite.endFill()

    // Direction
    this._riderSprite.beginFill(0xffffff, 0.8)
    this._riderSprite.drawPolygon([0, -10, -4, -6, 4, -6])
    this._riderSprite.endFill()
  }

  _followCamera(riderPx) {
    const w = this.app.screen.width
    const h = this.app.screen.height
    const targetX = w / 2 - riderPx.x
    const targetY = h / 2 - riderPx.y

    this.app.stage.x += (targetX - this.app.stage.x) * 0.08
    this.app.stage.y += (targetY - this.app.stage.y) * 0.08
  }

  _gradientColor(gradient) {
    if (gradient > 8) return 0x7c3aed      // violet — HC
    if (gradient > 5) return 0xef4444      // rouge — montagne
    if (gradient > 2) return 0xf97316      // orange — côte
    if (gradient > 0) return 0xfbbf24      // jaune — faux-plat
    if (gradient < -3) return 0x60a5fa     // bleu — descente
    return 0x4a5568                         // gris — plat
  }

  destroy() {
    this.app.destroy(false)
  }
}
