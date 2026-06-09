<template>
  <div class="hud">
    <!-- Panneau énergie gauche -->
    <div class="hud-panel hud-left">
      <div class="rider-name">{{ rider.name }}</div>

      <!-- Jauge Endurance -->
      <div class="gauge-block">
        <div class="gauge-header">
          <span class="gauge-label">Endurance</span>
          <span class="gauge-value">{{ endurancePct }}%</span>
        </div>
        <div class="gauge-bar endurance-bar">
          <div
            class="gauge-fill endurance-fill"
            :style="{ width: endurancePct + '%' }"
            :class="{ 'gauge-critical': endurancePct < 20 }"
          />
        </div>
      </div>

      <!-- Jauge W' -->
      <div class="gauge-block">
        <div class="gauge-header">
          <span class="gauge-label">W' Anaérobie</span>
          <span class="gauge-value" :class="{ 'text-red': wPrimePct < 20 }">{{ wPrimePct }}%</span>
        </div>
        <div class="gauge-bar wprime-bar">
          <div
            class="gauge-fill wprime-fill"
            :style="{ width: wPrimePct + '%', backgroundColor: wPrimeColor }"
            :class="{ 'gauge-blink': wPrimePct < 20 }"
          />
        </div>
      </div>

      <!-- Zone d'effort active -->
      <div class="zone-display" :style="{ borderColor: activeZone.color }">
        <div class="zone-badge" :style="{ backgroundColor: activeZone.color }">
          {{ activeZone.label }}
        </div>
        <span class="zone-name">{{ activeZone.name }}</span>
      </div>

      <!-- Explosion alert -->
      <div v-if="rider.energy.exploded" class="explosion-alert">
        ⚠ DÉFAILLANCE — Puissance bridée
      </div>
    </div>

    <!-- Panneau stats centre-haut -->
    <div class="hud-speed">
      <div class="speed-value">{{ Math.round(rider.speedKmh) }}</div>
      <div class="speed-unit">km/h</div>
    </div>

    <!-- Panneau actions droite -->
    <div class="hud-panel hud-right">
      <div class="panel-title">Mode d'effort</div>

      <div class="effort-buttons">
        <button
          v-for="mode in effortModes"
          :key="mode.key"
          class="effort-btn"
          :class="{ active: rider.effortMode === mode.key }"
          :style="rider.effortMode === mode.key ? { borderColor: mode.color, backgroundColor: mode.color + '22' } : {}"
          @click="$emit('setEffort', mode.key)"
        >
          <span class="btn-label" :style="rider.effortMode === mode.key ? { color: mode.color } : {}">
            {{ mode.label }}
          </span>
          <span class="btn-zone">{{ mode.zone }}</span>
        </button>
      </div>

      <!-- Vitesse accélération simulation -->
      <div class="timescale-block">
        <div class="panel-title" style="margin-top:12px">Vitesse sim</div>
        <div class="timescale-buttons">
          <button
            v-for="scale in timeScales"
            :key="scale"
            class="scale-btn"
            :class="{ active: currentTimeScale === scale }"
            @click="$emit('setTimeScale', scale)"
          >×{{ scale }}</button>
        </div>
      </div>
    </div>

    <!-- Radio DS (haut gauche) -->
    <transition name="ds-fade">
      <div v-if="dsMessage" class="ds-radio">
        <div class="ds-header">
          <span class="ds-icon">📻</span>
          <span class="ds-title">Directeur Sportif</span>
        </div>
        <div class="ds-text">{{ dsMessage.text }}</div>
        <div class="ds-actions">
          <button class="ds-btn ds-follow" @click="$emit('dsAction', 'follow')">✓ Suivre</button>
          <button class="ds-btn ds-ignore" @click="$emit('dsAction', 'ignore')">✗ Ignorer</button>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { ZONES, EFFORT_MODES } from '../simulation/engine.js'

const props = defineProps({
  rider: { type: Object, required: true },
  dsMessage: { type: Object, default: null },
  currentTimeScale: { type: Number, default: 1 },
})

defineEmits(['setEffort', 'dsAction', 'setTimeScale'])

const endurancePct = computed(() => {
  const e = props.rider.energy.endurance
  return Math.round((e.current / e.max) * 100)
})

const wPrimePct = computed(() => {
  const w = props.rider.energy.wPrime
  return Math.round((w.current / w.max) * 100)
})

const wPrimeColor = computed(() => {
  if (wPrimePct.value < 10) return '#dc2626'
  if (wPrimePct.value < 30) return '#f97316'
  return '#fbbf24'
})

const activeZone = computed(() => {
  const z = props.rider.energy.zone ?? 2
  return Object.values(ZONES).find(zn => zn.id === z) ?? ZONES.Z2
})

const effortModes = [
  { key: 'eco',      label: 'Éco',      zone: 'Z2',    color: '#34d399' },
  { key: 'maintien', label: 'Maintien', zone: 'Z3–4',  color: '#fbbf24' },
  { key: 'attaque',  label: 'Attaque',  zone: 'Z5–6',  color: '#ef4444' },
]

const timeScales = [1, 5, 10, 30]
</script>

<style scoped>
.hud {
  position: absolute;
  inset: 0;
  pointer-events: none;
  font-family: 'Segoe UI', system-ui, sans-serif;
}

.hud-panel {
  position: absolute;
  background: rgba(0, 0, 0, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 12px 14px;
  backdrop-filter: blur(6px);
  pointer-events: all;
  min-width: 180px;
}

.hud-left  { top: 16px; left: 16px; }
.hud-right { top: 16px; right: 16px; }

.rider-name {
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 10px;
}

.panel-title {
  font-size: 9px;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 8px;
}

/* Jauges */
.gauge-block { margin-bottom: 10px; }

.gauge-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}

.gauge-label {
  font-size: 10px;
  color: rgba(255,255,255,0.6);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.gauge-value {
  font-size: 10px;
  color: #fff;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.text-red { color: #ef4444 !important; }

.gauge-bar {
  height: 6px;
  background: rgba(255,255,255,0.1);
  border-radius: 3px;
  overflow: hidden;
}

.endurance-bar .gauge-fill {
  height: 100%;
  background: #60a5fa;
  border-radius: 3px;
  transition: width 0.3s ease, background-color 0.5s;
}

.wprime-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.gauge-critical { background: #ef4444 !important; }

.gauge-blink {
  animation: blink 0.5s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* Zone active */
.zone-display {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  border: 1px solid;
  border-radius: 6px;
  padding: 6px 8px;
  transition: border-color 0.3s;
}

.zone-badge {
  font-size: 11px;
  font-weight: 700;
  color: #000;
  padding: 2px 6px;
  border-radius: 4px;
  min-width: 24px;
  text-align: center;
}

.zone-name {
  font-size: 11px;
  color: rgba(255,255,255,0.8);
}

/* Explosion */
.explosion-alert {
  margin-top: 8px;
  background: rgba(220, 38, 38, 0.3);
  border: 1px solid #ef4444;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 10px;
  color: #ef4444;
  text-align: center;
  animation: blink 1s infinite;
}

/* Vitesse */
.hud-speed {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.75);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px;
  padding: 8px 20px;
  text-align: center;
  backdrop-filter: blur(6px);
}

.speed-value {
  font-size: 36px;
  font-weight: 700;
  color: #fff;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.speed-unit {
  font-size: 10px;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* Actions d'effort */
.effort-buttons {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.effort-btn {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  transition: all 0.15s;
  color: #fff;
}

.effort-btn:hover {
  background: rgba(255,255,255,0.1);
}

.effort-btn.active {
  background: rgba(255,255,255,0.08);
}

.btn-label {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255,255,255,0.8);
}

.btn-zone {
  font-size: 10px;
  color: rgba(255,255,255,0.4);
}

/* Time scale */
.timescale-buttons {
  display: flex;
  gap: 4px;
}

.scale-btn {
  flex: 1;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 4px;
  padding: 4px;
  font-size: 10px;
  color: rgba(255,255,255,0.6);
  cursor: pointer;
  transition: all 0.15s;
}

.scale-btn:hover { background: rgba(255,255,255,0.1); }
.scale-btn.active {
  background: rgba(251,191,36,0.2);
  border-color: #fbbf24;
  color: #fbbf24;
}

/* Radio DS */
.ds-radio {
  position: absolute;
  top: 16px;
  left: 210px;
  background: rgba(0,0,0,0.8);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 8px;
  padding: 10px 12px;
  min-width: 240px;
  max-width: 300px;
  backdrop-filter: blur(6px);
  pointer-events: all;
}

.ds-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.ds-icon { font-size: 14px; }
.ds-title { font-size: 10px; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 1px; }

.ds-text {
  font-size: 12px;
  color: #fff;
  line-height: 1.5;
  margin-bottom: 8px;
  font-style: italic;
}

.ds-actions {
  display: flex;
  gap: 8px;
}

.ds-btn {
  flex: 1;
  border-radius: 4px;
  padding: 4px;
  font-size: 10px;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.15s;
}

.ds-follow { background: rgba(52,211,153,0.15); border-color: #34d399; color: #34d399; }
.ds-follow:hover { background: rgba(52,211,153,0.3); }
.ds-ignore { background: rgba(239,68,68,0.15); border-color: #ef4444; color: #ef4444; }
.ds-ignore:hover { background: rgba(239,68,68,0.3); }

.ds-fade-enter-active, .ds-fade-leave-active { transition: all 0.3s ease; }
.ds-fade-enter-from, .ds-fade-leave-to { opacity: 0; transform: translateY(-8px); }
</style>
