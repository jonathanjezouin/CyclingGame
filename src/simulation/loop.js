/**
 * Boucle de simulation — découplée du rendu (60 FPS).
 * Le tick rate peut être accéléré sans toucher au render loop.
 *
 * Le rider expose aussi `renderPos` pour l'interpolation fluide :
 *   rider.renderPos = position interpolée à afficher (mis à jour à 60 FPS)
 *   rider.splinePos = position simulée (mis à jour par ticks discrets)
 */
import { simulateTick, updateGroups, computeScreenCount, decidePowerTarget } from './engine.js'

export class SimulationLoop {
  /**
   * @param {Object} options
   * @param {Array}  options.riders  - tableau de tous les coureurs (joueur + IA)
   * @param {Object} options.route
   * @param {Function} options.onTick
   */
  constructor({ riders, route, onTick }) {
    this.riders    = riders
    this.route     = route
    this.onTick    = onTick
    this.timeScale = 1
    this.running   = false
    this.paused    = false
    this._accumulator  = 0
    this._lastTime     = null
    this._rafId        = null
    this.elapsedSimSec = 0

    // Interpolation par coureur : {id: {posBeforeLast, posAfterLast}}
    this._interp = {}
    for (const r of this.riders) {
      r.renderPos = 0
      this._interp[r.id] = { before: 0, after: 0 }
    }
    this.groups = []
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

        // Traite les ticks (max 120 par frame)
        let ticks = 0
        while (this._accumulator >= 1 && ticks < 120) {
          // Bloc A : recalcul des groupes (étagement longitudinal) puis du
          // nombre d'écrans dans le cône frontal de chaque coureur. Fait avant
          // les ticks pour que le draft de ce tick reflète la position courante.
          this.groups = updateGroups(this.riders)
          for (const rider of this.riders) {
            rider.screenCount = computeScreenCount(rider, this.riders)
          }

          for (const rider of this.riders) {
            // Couche 1 : décision de ZONE cible avant le tick (joueur exclu —
            // il pilote sa propre zone via le HUD). decidePowerTarget mute
            // rider.targetZone et le journal de raisonnement (B1).
            if (!rider.isPlayer) {
              decidePowerTarget(rider, this.route, { simSec: this.elapsedSimSec })
            }
            this._interp[rider.id].before = rider.splinePos
            simulateTick(rider, this.route, 1)
            this._interp[rider.id].after  = rider.splinePos
          }
          this.elapsedSimSec++
          this._accumulator -= 1
          ticks++
        }

        // Interpolation renderPos pour chaque coureur
        const t = Math.min(this._accumulator, 1)
        for (const rider of this.riders) {
          const ip = this._interp[rider.id]
          rider.renderPos = ip.before + (ip.after - ip.before) * t
        }

        if (ticks > 0) {
          this.onTick({ riders: this.riders, groups: this.groups, elapsedSimSec: this.elapsedSimSec })
        }

        // Fin de course (quand le joueur arrive)
        const player = this.riders.find(r => r.isPlayer)
        if (player && player.splinePos >= this.route.totalLength) {
          this.stop()
          this.onTick({ riders: this.riders, elapsedSimSec: this.elapsedSimSec, finished: true })
          return
        }
      }

      this._loop()
    })
  }
}
