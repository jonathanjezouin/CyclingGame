<template>
  <div class="app">
    <canvas ref="canvasEl" class="game-canvas" />

    <HUD
      v-if="gameState === 'racing'"
      :rider="playerRider"
      :dsMessage="dsMessage"
      :currentTimeScale="timeScale"
      :paused="paused"
      @setTargetZone="setTargetZone"
      @dsAction="handleDsAction"
      @setTimeScale="setTimeScale"
      @togglePause="togglePause"
    />

    <!-- B1 — Fiche coureur (clic gauche sur un pion) -->
    <RiderCard
      v-if="gameState === 'racing' && selectedRider"
      :rider="selectedRider"
      @close="selectedRiderId = null"
    />

    <div v-if="gameState === 'racing'" class="altimetric-bar">
      <AltimetricProfile
        :track="track"
        :spline="splineInstance"
        :splinePos="playerRider.splinePos"
        :width="altWidth"
        :svgHeight="64"
      />
    </div>

    <!-- Écran de départ -->
    <div v-if="gameState === 'start'" class="start-screen">
      <div class="start-card">
        <div class="game-title">🚴 Vélo Manager / Rider</div>
        <div class="game-subtitle">POC — v0.1</div>
        <div class="track-info" v-if="track">
          <div class="track-name">{{ track.name }}</div>
          <div class="track-meta">{{ track.distance_km }} km · {{ track.type }} · {{ riders.length }} coureurs</div>
          <div class="track-hint">Molette : zoom · Espace : pause · C : cônes d'aspiration</div>
        </div>
        <button class="start-btn" @click="startRace">Démarrer la course</button>
      </div>
    </div>

    <!-- Pause overlay -->
    <div v-if="paused && gameState === 'racing'" class="pause-overlay">
      <div class="pause-badge">⏸ PAUSE</div>
    </div>

    <!-- Écran d'arrivée -->
    <div v-if="gameState === 'finished'" class="finish-screen">
      <div class="finish-card">
        <div class="finish-emoji">🏁</div>
        <div class="finish-title">Arrivée !</div>
        <div class="finish-stats">
          <div class="stat-row">
            <span class="stat-label">Temps simulé</span>
            <span class="stat-value">{{ formatTime(elapsedSimSec) }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Endurance restante</span>
            <span class="stat-value">{{ Math.round((playerRider.energy.endurance.current / playerRider.energy.endurance.max) * 100) }}%</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">W' restant</span>
            <span class="stat-value">{{ Math.round((playerRider.energy.wPrime.current / playerRider.energy.wPrime.max) * 100) }}%</span>
          </div>
          <div class="stat-row" v-if="playerRider.energy.exploded">
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
import { ref, computed, onMounted, onUnmounted } from 'vue'
import HUD from './ui/HUD.vue'
import RiderCard from './ui/RiderCard.vue'
import AltimetricProfile from './ui/AltimetricProfile.vue'
import { createRider, createAIRider, createRidersFromRoster } from './simulation/engine.js'
import { SimulationLoop } from './simulation/loop.js'
import { CatmullRomSpline } from './render/spline.js'
import { GameRenderer } from './render/renderer.js'
import trackData from './data/track_poc.json'
import rosterData from './data/roster_poc.json'

// ─── État ────────────────────────────────────────────────────────────────────
const canvasEl       = ref(null)
const gameState      = ref('start')
const dsMessage      = ref(null)
const timeScale      = ref(1)
const paused         = ref(false)
const elapsedSimSec  = ref(0)
const splineInstance = ref(null)

const track    = ref(trackData)
const altWidth = computed(() => Math.min(600, window.innerWidth - 40))

// Coureurs — tableau réactif, chargés depuis le roster (Bloc A)
const riders = ref(createRidersFromRoster(rosterData))
const conesOn = ref(false)

const playerRider = computed(() => riders.value.find(r => r.isPlayer))

// B1 — fiche coureur (clic gauche sur un pion, Zoom 3)
const selectedRiderId = ref(null)
const selectedRider = computed(() => riders.value.find(r => r.id === selectedRiderId.value) ?? null)

function onRiderClick(riderId) {
  // Toggle : recliquer le même coureur referme la fiche.
  selectedRiderId.value = selectedRiderId.value === riderId ? null : riderId
}

let renderer = null
let simLoop  = null
let dsTimer  = null
let rafId    = null

// ─── Init ────────────────────────────────────────────────────────────────────
onMounted(() => {
  renderer = new GameRenderer(canvasEl.value)

  const spline = new CatmullRomSpline(track.value.points)
  splineInstance.value = spline

  // Passer la largeur uniforme au renderer (pas de segments de largeur variable)
  renderer.drawRoad(spline)
  renderer.initRiders(riders.value.map(r => ({ id: r.id, isPlayer: r.isPlayer })), onRiderClick)

  // Render loop 60 FPS
  const renderLoop = () => {
    renderer.updateRiders(riders.value, spline, playerRider.value?.id)
    rafId = requestAnimationFrame(renderLoop)
  }
  rafId = requestAnimationFrame(renderLoop)

  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  simLoop?.stop()
  renderer?.destroy()
  clearTimeout(dsTimer)
  if (rafId) cancelAnimationFrame(rafId)
  window.removeEventListener('keydown', onKeyDown)
})

function onKeyDown(e) {
  if (e.code === 'Space' && gameState.value === 'racing') {
    e.preventDefault()
    togglePause()
  }
  // Bloc A : toggle debug des cônes d'aspiration
  if (e.code === 'KeyC') {
    conesOn.value = renderer ? renderer.toggleCones() : false
  }
}

// ─── Démarrage ───────────────────────────────────────────────────────────────
function startRace() {
  gameState.value = 'racing'
  paused.value    = false

  const spline = splineInstance.value
  const routeAdapter = {
    totalLength:   spline.totalLength,
    getGradientAt: (pos) => spline.getGradientAt(pos),
    // IA0 (PBI v1.1) — dérivation route : segments (m, déjà dans cette unité
    // dans le JSON) et keyPoints (convertis de km vers splinePos en m).
    segments:  track.value.segments ?? [],
    keyPoints: (track.value.keyPoints ?? []).map(kp => ({
      ...kp,
      splinePos: spline.getSplinePosAtKm(kp.km),
    })),
  }

  simLoop = new SimulationLoop({
    riders: riders.value,
    route:  routeAdapter,
    onTick: ({ elapsedSimSec: sec, finished }) => {
      elapsedSimSec.value = sec
      if (finished) gameState.value = 'finished'
    },
  })

  simLoop.start()
  scheduleDsMessage()
}

// ─── Contrôles ───────────────────────────────────────────────────────────────
function setTargetZone(zone) {
  const p = riders.value.find(r => r.isPlayer)
  if (p) p.targetZone = zone
}

function setTimeScale(scale) {
  timeScale.value = scale
  simLoop?.setTimeScale(scale)
}

function togglePause() {
  if (!simLoop) return
  paused.value = simLoop.pause()
}

// ─── Radio DS ────────────────────────────────────────────────────────────────
function scheduleDsMessage() {
  const delay = (15 + Math.random() * 20) * 1000
  dsTimer = setTimeout(async () => {
    if (gameState.value !== 'racing') return
    await triggerDsMessage()
  }, delay)
}

async function triggerDsMessage() {
  const r      = playerRider.value
  const spline = splineInstance.value
  const context = {
    kmDone:       spline ? spline.getKmAt(r.splinePos).toFixed(1) : '?',
    speedKmh:     r.speedKmh.toFixed(0),
    endurancePct: Math.round((r.energy.endurance.current / r.energy.endurance.max) * 100),
    wPrimePct:    Math.round((r.energy.wPrime.current / r.energy.wPrime.max) * 100),
    zone:         r.energy.zone,
    effortMode:   r.effortMode,
    gradient:     spline ? spline.getGradientAt(r.splinePos).toFixed(1) : '0',
  }

  let text
  if (window.electronAPI) {
    const res = await window.electronAPI.slmGenerate({ context, dsProfile: 'encourageant' })
    text = res.text
  } else {
    const msgs = [
      'Reste dans ta roue, économise tes forces.',
      'Attention, la montée arrive. Passe en mode Éco.',
      'Beau travail. Continue à ce rythme.',
      `Endurance à ${context.endurancePct}% — gère bien jusqu'à l'arrivée.`,
      `Tu as les jambes aujourd'hui. Attaque si tu te sens bien.`,
      `${context.kmDone} km parcourus. Bon rythme.`,
    ]
    text = msgs[Math.floor(Math.random() * msgs.length)]
  }

  dsMessage.value = { text, timestamp: Date.now() }
  setTimeout(() => { dsMessage.value = null }, 12000)
  if (gameState.value === 'racing') scheduleDsMessage()
}

function handleDsAction() {
  dsMessage.value = null
}

// ─── Reset ───────────────────────────────────────────────────────────────────
function resetRace() {
  simLoop?.stop()
  clearTimeout(dsTimer)
  dsMessage.value     = null
  paused.value        = false
  elapsedSimSec.value = 0

  riders.value = createRidersFromRoster(rosterData)
  selectedRiderId.value = null
  renderer.initRiders(riders.value.map(r => ({ id: r.id, isPlayer: r.isPlayer })), onRiderClick)
  gameState.value = 'start'
}

function formatTime(totalSec) {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0
    ? `${h}h${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s`
    : `${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s`
}
</script>

<style>
html, body, #app, .app {
  width: 100vw; height: 100vh;
  margin: 0; padding: 0;
  overflow: hidden;
  background: #1a1a2e;
}
.app { position: relative; }
.game-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }

.altimetric-bar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
}

.pause-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.pause-badge {
  font-size: 22px; font-weight: 700;
  color: rgba(255,255,255,0.85);
  background: rgba(0,0,0,0.55);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 12px;
  padding: 10px 28px;
  backdrop-filter: blur(4px);
  letter-spacing: 3px;
}

.start-screen, .finish-screen {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(4px);
}
.start-card, .finish-card {
  background: rgba(15,15,30,0.95);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 16px;
  padding: 40px 48px;
  text-align: center;
  min-width: 320px;
}
.game-title    { font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 4px; }
.game-subtitle { font-size: 12px; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 2px; margin-bottom: 24px; }
.track-info    { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; }
.track-name    { font-size: 16px; color: #fff; font-weight: 600; }
.track-meta    { font-size: 12px; color: rgba(255,255,255,0.5); margin-top: 4px; }
.track-hint    { font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 6px; letter-spacing: 0.5px; }
.start-btn {
  background: #3b82f6; border: none; border-radius: 8px;
  padding: 12px 32px; font-size: 16px; font-weight: 600;
  color: #fff; cursor: pointer; transition: all 0.15s; width: 100%;
}
.start-btn:hover { background: #2563eb; transform: translateY(-1px); }

.finish-emoji  { font-size: 48px; margin-bottom: 8px; }
.finish-title  { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 20px; }
.finish-stats  { text-align: left; margin-bottom: 24px; }
.stat-row      { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.stat-label    { font-size: 12px; color: rgba(255,255,255,0.5); }
.stat-value    { font-size: 12px; color: #fff; font-weight: 600; }
</style>
