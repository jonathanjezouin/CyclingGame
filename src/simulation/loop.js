/**
 * Boucle de simulation — découplée du rendu (60 FPS).
 * Le tick rate peut être accéléré sans toucher au render loop.
 *
 * Le rider expose aussi `renderPos` pour l'interpolation fluide :
 *   rider.renderPos = position interpolée à afficher (mis à jour à 60 FPS)
 *   rider.splinePos = position simulée (mis à jour par ticks discrets)
 */
import { simulateTick } from './engine.js'

export class SimulationLoop {
  constructor({ rider, route, onTick }) {
    this.rider     = rider
    this.route     = route
    this.onTick    = onTick
    this.timeScale = 1
    this.running   = false
    this.paused    = false
    this._accumulator = 0
    this._lastTime    = null
    this._rafId       = null
    this.elapsedSimSec = 0

    // Position de rendu interpolée (mise à jour à 60 FPS)
    this.rider.renderPos = 0
    this._prevSimPos = 0  // position sim au tick précédent
    this._nextSimPos = 0  // position sim au tick suivant (cible)
    this._tickProgress = 0  // 0→1 entre deux ticks
  }

  start() {
    this.running = true
    this.paused  = false
    this._lastTime = performance.now()
    this._loop()
  }

  stop() {
    this.running = false
    if (this._rafId) cancelAnimationFrame(this._rafId)
  }

  pause() {
    this.paused = !this.paused
    if (!this.paused) {
      // Reprendre : réinitialiser le temps pour éviter un saut
      this._lastTime = performance.now()
      this._accumulator = 0
    }
    return this.paused
  }

  setTimeScale(scale) {
    this.timeScale = Math.max(1, Math.min(60, scale))
    this._accumulator = 0  // reset pour éviter rafale de ticks
  }

  _loop() {
    if (!this.running) return

    this._rafId = requestAnimationFrame((now) => {
      const realDt = Math.min((now - this._lastTime) / 1000, 0.1)  // cap 100ms
      this._lastTime = now

      if (!this.paused) {
        this._accumulator += realDt * this.timeScale

        // Traite les ticks (max 60 par frame)
        let ticks = 0
        while (this._accumulator >= 1 && ticks < 60) {
          this._prevSimPos = this.rider.splinePos
          simulateTick(this.rider, this.route, 1)
          this._nextSimPos = this.rider.splinePos
          this.elapsedSimSec++
          this._accumulator -= 1
          ticks++
        }

        // Progression entre ticks pour interpolation (0 → 1)
        this._tickProgress = Math.min(this._accumulator, 1)

        // Interpolation douce de la position de rendu
        const simSpeed = this.rider.speedKmh / 3.6  // m/s
        // Position interpolée : on anticipe la distance qui sera parcourue
        // pendant la fraction de tick restante
        const interpDist = simSpeed * (this._tickProgress / this.timeScale)
        this.rider.renderPos = Math.min(
          this.rider.splinePos + interpDist,
          this.route.totalLength
        )

        if (ticks > 0) {
          this.onTick({ rider: this.rider, elapsedSimSec: this.elapsedSimSec })
        }

        // Fin de course
        if (this.rider.splinePos >= this.route.totalLength) {
          this.stop()
          this.onTick({ rider: this.rider, elapsedSimSec: this.elapsedSimSec, finished: true })
          return
        }
      }

      this._loop()
    })
  }
}
