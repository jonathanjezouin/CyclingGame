/**
 * Boucle de simulation — découplée du rendu (60 FPS).
 * Le tick rate peut être accéléré sans toucher au render loop.
 */
import { simulateTick } from './engine.js'

export class SimulationLoop {
  constructor({ rider, route, onTick }) {
    this.rider = rider
    this.route = route
    this.onTick = onTick       // callback appelé après chaque tick
    this.timeScale = 1         // x1 = temps réel, x10 = 10s simulées/s réelle
    this.running = false
    this._accumulator = 0
    this._lastTime = null
    this._rafId = null
    this.elapsedSimSec = 0     // temps simulé total en secondes
  }

  start() {
    this.running = true
    this._lastTime = performance.now()
    this._loop()
  }

  stop() {
    this.running = false
    if (this._rafId) cancelAnimationFrame(this._rafId)
  }

  setTimeScale(scale) {
    this.timeScale = Math.max(1, Math.min(60, scale))
  }

  _loop() {
    if (!this.running) return

    this._rafId = requestAnimationFrame((now) => {
      const realDt = (now - this._lastTime) / 1000 // secondes réelles
      this._lastTime = now

      // Accumule les secondes simulées à traiter
      this._accumulator += realDt * this.timeScale

      // Traite les ticks (max 60 par frame pour éviter les freeze)
      let ticks = 0
      while (this._accumulator >= 1 && ticks < 60) {
        simulateTick(this.rider, this.route, 1)
        this.elapsedSimSec++
        this._accumulator -= 1
        ticks++
      }

      if (ticks > 0) {
        this.onTick({ rider: this.rider, elapsedSimSec: this.elapsedSimSec })
      }

      // Fin de course
      if (this.rider.splinePos >= this.route.totalLength) {
        this.stop()
        this.onTick({ rider: this.rider, elapsedSimSec: this.elapsedSimSec, finished: true })
        return
      }

      this._loop()
    })
  }
}
