<template>
  <div class="app">
    <!-- Canvas Pixi.js -->
    <canvas ref="canvasEl" class="game-canvas" />

    <!-- HUD Vue -->
    <HUD
      v-if="gameState === 'racing'"
      :rider="rider"
      :dsMessage="dsMessage"
      :currentTimeScale="timeScale"
      @setEffort="setEffortMode"
      @dsAction="handleDsAction"
      @setTimeScale="setTimeScale"
    />

    <!-- Bandeau altimétrique bas d'écran -->
    <div v-if="gameState === 'racing'" class="altimetric-bar">
      <AltimetricProfile
        :track="track"
        :splinePos="rider.splinePos"
        :width="altWidth"
        :height="64"
      />
    </div>

    <!-- Écran de départ -->
    <div v-if="gameState === 'start'" class="start-screen">
      <div class="start-card">
        <div class="game-title">🚴 Vélo Manager / Rider</div>
        <div class="game-subtitle">POC — v0.1</div>
        <div class="track-info" v-if="track">
          <div class="track-name">{{ track.name }}</div>
          <div class="track-meta">{{ track.distance_km }} km · {{ track.type }}</div>
        </div>
        <button class="start-btn" @click="startRace">Démarrer la course</button>
      </div>
    </div>

    <!-- Écran d'arrivée -->
    <div v-if="gameState === 'finished'" class="finish-screen">
      <div class="finish-card">
        <div class="finish-emoji">🏁</div>
        <div class="finish-title">Arrivée !</div>
        <div class="finish-stats">
          <div class="stat-row">
            <span class="stat-label">Temps simulé</span>
            <span class="stat-value">{{ formatTime(simLoop?.elapsedSimSec ?? 0) }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Endurance restante</span>
            <span class="stat-value">{{ Math.round((rider.energy.endurance.current / rider.energy.endurance.max) * 100) }}%</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">W' restant</span>
            <span class="stat-value">{{ Math.round((rider.energy.wPrime.current / rider.energy.wPrime.max) * 100) }}%</span>
          </div>
          <div class="stat-row" v-if="rider.energy.exploded">
            <span class="stat-label">⚠ Défaillance</span>
            <span class="stat-value" style="color:#ef4444">Oui</span>
          </div>
        </div>
        <button class="start-btn" @click="resetRace">Recommencer</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import HUD from './ui/HUD.vue'
import AltimetricProfile from './ui/AltimetricProfile.vue'
import { createRider } from './simulation/engine.js'
import { SimulationLoop } from './simulation/loop.js'
import { CatmullRomSpline } from './render/spline.js'
import { GameRenderer } from './render/renderer.js'
import trackData from './data/track_poc.json'

// ─── État global ────────────────────────────────────────────────────────────
const canvasEl = ref(null)
const gameState = ref('start') // 'start' | 'racing' | 'finished'
const rider = ref(createRider())
const dsMessage = ref(null)
const timeScale = ref(1)
const altWidth = computed(() => Math.min(600, window.innerWidth - 40))

const track = ref(trackData)
let spline = null
let renderer = null
let simLoop = null
let dsTimer = null
let renderLoop = null

// ─── Init ────────────────────────────────────────────────────────────────────
onMounted(() => {
  renderer = new GameRenderer(canvasEl.value)
  spline = new CatmullRomSpline(track.value.points.map(p => ({
    ...p,
    // Coordonnées en pixels (scale: 1km = ~100px pour ce tracé)
    x: p.x,
    y: p.y,
  })))

  renderer.drawRoad(spline, track.value.segments)
  renderer.initRider(rider.value)

  // Render loop (60 FPS) — indépendant du tick rate
  const loop = () => {
    renderer.updateRider(rider.value, spline)
    renderLoop = requestAnimationFrame(loop)
  }
  renderLoop = requestAnimationFrame(loop)
})

onUnmounted(() => {
  simLoop?.stop()
  renderer?.destroy()
  clearTimeout(dsTimer)
  if (renderLoop) cancelAnimationFrame(renderLoop)
})

// ─── Démarrage ───────────────────────────────────────────────────────────────
function startRace() {
  gameState.value = 'racing'

  const routeAdapter = {
    totalLength: spline.totalLength,
    getGradientAt: (pos) => spline.getGradientAt(pos),
  }

  simLoop = new SimulationLoop({
    rider: rider.value,
    route: routeAdapter,
    onTick: ({ rider: r, elapsedSimSec, finished }) => {
      if (finished) {
        gameState.value = 'finished'
      }
    },
  })

  simLoop.start()
  scheduleDsMessage()
}

// ─── Actions joueur ──────────────────────────────────────────────────────────
function setEffortMode(mode) {
  rider.value.effortMode = mode
}

function setTimeScale(scale) {
  timeScale.value = scale
  simLoop?.setTimeScale(scale)
}

// ─── Radio DS ────────────────────────────────────────────────────────────────
function scheduleDsMessage() {
  const delay = 15000 + Math.random() * 20000 // 15–35s
  dsTimer = setTimeout(async () => {
    await triggerDsMessage()
  }, delay)
}

async function triggerDsMessage() {
  try {
    const context = {
      splinePos: rider.value.splinePos,
      speedKmh: rider.value.speedKmh,
      endurancePct: Math.round((rider.value.energy.endurance.current / rider.value.energy.endurance.max) * 100),
      wPrimePct: Math.round((rider.value.energy.wPrime.current / rider.value.energy.wPrime.max) * 100),
      zone: rider.value.energy.zone,
      effortMode: rider.value.effortMode,
    }

    let text
    if (window.electronAPI) {
      const res = await window.electronAPI.slmGenerate({ context, dsProfile: 'encourageant' })
      text = res.text
    } else {
      // Fallback navigateur (dev sans Electron)
      const messages = [
        'Reste dans ta roue, économise tes forces.',
        'Attention, la montée arrive dans 2 km. Passe en mode Éco.',
        'Beau travail. Continue à ce rythme.',
        'Ne te laisse pas distancer, reviens dans le groupe.',
        'Tu as les jambes aujourd\'hui. Attaque si tu te sens bien.',
        `Énergie à ${context.endurancePct}%, gère bien jusqu'à l'arrivée.`,
      ]
      text = messages[Math.floor(Math.random() * messages.length)]
    }

    dsMessage.value = { text, timestamp: Date.now() }

    // Auto-dismiss après 12s
    setTimeout(() => {
      if (dsMessage.value?.timestamp === dsMessage.value?.timestamp) {
        dsMessage.value = null
      }
    }, 12000)

    if (gameState.value === 'racing') scheduleDsMessage()
  } catch (e) {
    console.warn('DS message error:', e)
  }
}

function handleDsAction(action) {
  // TODO Phase 1 : impacter la relation DS selon l'action
  console.log('DS action:', action)
  dsMessage.value = null
}

// ─── Reset ───────────────────────────────────────────────────────────────────
function resetRace() {
  simLoop?.stop()
  clearTimeout(dsTimer)
  dsMessage.value = null
  rider.value = createRider()
  renderer.initRider(rider.value)
  gameState.value = 'start'
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────
function formatTime(totalSec) {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0
    ? `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`
    : `${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`
}
</script>

<style>
html, body, #app, .app {
  width: 100vw;
  height: 100vh;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #1a1a2e;
}

.app {
  position: relative;
}

.game-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* Bandeau altimétrique */
.altimetric-bar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
}

/* Écrans de menu */
.start-screen, .finish-screen {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(4px);
}

.start-card, .finish-card {
  background: rgba(15, 15, 30, 0.95);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 16px;
  padding: 40px 48px;
  text-align: center;
  min-width: 320px;
}

.game-title {
  font-size: 28px;
  font-weight: 700;
  color: #fff;
  margin-bottom: 4px;
}

.game-subtitle {
  font-size: 12px;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
  letter-spacing: 2px;
  margin-bottom: 24px;
}

.track-info {
  background: rgba(255,255,255,0.05);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 24px;
}

.track-name {
  font-size: 16px;
  color: #fff;
  font-weight: 600;
}

.track-meta {
  font-size: 12px;
  color: rgba(255,255,255,0.5);
  margin-top: 4px;
}

.start-btn {
  background: #3b82f6;
  border: none;
  border-radius: 8px;
  padding: 12px 32px;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  transition: all 0.15s;
  width: 100%;
}

.start-btn:hover { background: #2563eb; transform: translateY(-1px); }

/* Finish screen */
.finish-emoji { font-size: 48px; margin-bottom: 8px; }
.finish-title { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 20px; }

.finish-stats { text-align: left; margin-bottom: 24px; }

.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

.stat-label { font-size: 12px; color: rgba(255,255,255,0.5); }
.stat-value { font-size: 12px; color: #fff; font-weight: 600; }
</style>
