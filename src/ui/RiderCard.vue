<template>
  <div class="rider-card">
    <div class="rc-header">
      <div class="rc-title">
        <span class="rc-name">{{ rider.name }}</span>
        <span class="rc-profile">{{ profileLabel }}</span>
      </div>
      <button class="rc-close" @click="$emit('close')">✕</button>
    </div>

    <!-- Attitude actuelle : zone cible + état dérivé -->
    <div class="rc-badges">
      <span class="rc-badge" :style="{ borderColor: zoneInfo.color, color: zoneInfo.color }">
        {{ zoneInfo.label }} · {{ zoneInfo.name }}
      </span>
      <span v-if="rider.isPlayer" class="rc-badge rc-badge-muted">Joueur</span>
      <span v-else class="rc-badge" :style="{ borderColor: stateInfo.color, color: stateInfo.color }">
        {{ stateInfo.label }}
      </span>
    </div>

    <!-- Caractéristiques physiologiques (constantes du coureur) -->
    <div class="rc-chars">
      <div class="rc-char"><span class="rc-char-k">Masse</span><span class="rc-char-v">{{ chars.mass }} kg</span></div>
      <div class="rc-char"><span class="rc-char-k">FTP</span><span class="rc-char-v">{{ chars.ftp }} W</span></div>
      <div class="rc-char"><span class="rc-char-k">W/kg</span><span class="rc-char-v">{{ chars.wkg }}</span></div>
      <div class="rc-char"><span class="rc-char-k">W'</span><span class="rc-char-v">{{ chars.wPrime }} kJ</span></div>
      <div class="rc-char"><span class="rc-char-k">P. anaér.</span><span class="rc-char-v">{{ chars.anaer }} W</span></div>
      <div class="rc-char"><span class="rc-char-k">Endurance</span><span class="rc-char-v">{{ chars.endF }}</span></div>
    </div>

    <!-- Jauges Endurance / W' -->
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

    <!-- Position dans le groupe -->
    <div class="rc-position">
      <span class="rc-group">{{ groupLabel }}</span>
      <span class="rc-rank">rang {{ rider.rankInGroup }}</span>
    </div>

    <!-- Journal de raisonnement IA (B1 — PBI v1.1) -->
    <div class="rc-log-section">
      <div class="panel-title">Raisonnement</div>

      <div v-if="rider.isPlayer" class="rc-log-empty">
        Coureur joueur — pas de journal IA, c'est toi qui décides.
      </div>
      <div v-else-if="!logEntries.length" class="rc-log-empty">
        Aucune décision enregistrée pour l'instant.
      </div>
      <ul v-else class="rc-log-list">
        <li v-for="(entry, i) in logEntries" :key="i" class="rc-log-entry">
          <div class="rc-log-meta">
            <span class="rc-log-time">{{ formatSimTime(entry.simSec) }}</span>
            <span class="rc-log-state" :style="{ color: (AI_STATE_INFO[entry.aiState] ?? {}).color }">
              {{ zoneLabel(entry.zone) }} · {{ (AI_STATE_INFO[entry.aiState] ?? {}).label ?? entry.aiState }}
            </span>
          </div>
          <div class="rc-log-reason">{{ entry.reason }}</div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { ZONES } from '../simulation/engine.js'

const props = defineProps({
  rider: { type: Object, required: true },
})

defineEmits(['close'])

// ─── Libellés ────────────────────────────────────────────────────────────────
const PROFILE_LABELS = {
  grimpeur:  'Grimpeur',
  rouleur:   'Rouleur',
  puncheur:  'Puncheur',
  sprinteur: 'Sprinteur',
}

const GROUP_LABELS = {
  peloton:        'Peloton',
  echappee:       'Échappée',
  poursuivants:   'Poursuivants',
  retardataires:  'Retardataires',
}

// États dérivés de la zone cible (couche 1) — aiState est désormais un libellé
// d'intensité ('economie' / 'soutenu' / 'effort_fort'), pas une machine d'état.
const AI_STATE_INFO = {
  economie:    { label: 'Économie',   color: '#34d399' },
  soutenu:     { label: 'Soutenu',    color: '#fbbf24' },
  effort_fort: { label: 'Gros effort', color: '#ef4444' },
}

const _zoneById = (id) => Object.values(ZONES).find(z => z.id === id)

const profileLabel = computed(() =>
  props.rider.isPlayer ? 'Toi' : (PROFILE_LABELS[props.rider.aiProfile] ?? props.rider.aiProfile ?? '—')
)

const groupLabel = computed(() => GROUP_LABELS[props.rider.group] ?? props.rider.group ?? '—')

// Caractéristiques physiologiques (constantes individuelles — couche 1).
const chars = computed(() => {
  const p = props.rider.profile ?? {}
  const mass = p.mass ?? 75
  const ftp = p.ftpWatts ?? props.rider.energy?.ftpWatts ?? 0
  return {
    mass: Math.round(mass * 10) / 10,
    ftp: Math.round(ftp),
    wkg: ftp && mass ? (ftp / mass).toFixed(2) : '—',
    wPrime: p.wPrimeJ != null ? (p.wPrimeJ / 1000).toFixed(1) : '—',
    anaer: p.maxAnaerobicPower != null ? Math.round(p.maxAnaerobicPower) : '—',
    endF: p.enduranceFactor != null ? p.enduranceFactor.toFixed(2) : '—',
  }
})

// Badge d'attitude : la zone cible courante du coureur.
const zoneInfo = computed(() => _zoneById(props.rider.targetZone) ?? ZONES.Z3)

const stateInfo = computed(() =>
  AI_STATE_INFO[props.rider.aiState] ?? AI_STATE_INFO.soutenu
)

function zoneLabel(zoneId) {
  return _zoneById(zoneId)?.label ?? `Z${zoneId}`
}

// ─── Jauges ──────────────────────────────────────────────────────────────────
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

// ─── Journal de raisonnement (B1) ────────────────────────────────────────────
// rider.aiLog : le plus récent en dernier (append). Affichage : le plus
// récent en premier (lecture naturelle "dernier raisonnement d'abord").
const logEntries = computed(() => [...(props.rider.aiLog ?? [])].reverse())

function formatSimTime(simSec) {
  if (simSec == null) return '—'
  const m = Math.floor(simSec / 60)
  const s = Math.floor(simSec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
</script>

<style scoped>
.rider-card {
  position: absolute;
  bottom: 16px;
  left: 16px;
  width: 280px;
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 12px 14px;
  backdrop-filter: blur(8px);
  pointer-events: all;
  font-family: 'Segoe UI', system-ui, sans-serif;
  z-index: 20;
}

.rc-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 10px;
}

.rc-title {
  display: flex;
  flex-direction: column;
}

.rc-name {
  font-size: 14px;
  font-weight: 700;
  color: #fff;
}

.rc-profile {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.5);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-top: 2px;
}

.rc-close {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.7);
  width: 24px;
  height: 24px;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
}
.rc-close:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}

.rc-badges {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}

.rc-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 2px 8px;
}

.rc-badge-muted {
  border-color: rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.5);
}

/* Caractéristiques physiologiques — grille compacte 2 colonnes */
.rc-chars {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 12px;
}
.rc-char { display: flex; justify-content: space-between; align-items: baseline; }
.rc-char-k {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.rc-char-v {
  font-size: 11px;
  color: #fff;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* Jauges — repris du style HUD (ui/HUD.vue) */
.gauge-block { margin-bottom: 10px; }

.gauge-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}

.gauge-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.6);
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
  background: rgba(255, 255, 255, 0.1);
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

.gauge-blink { animation: rc-blink 0.5s infinite; }

@keyframes rc-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* Position groupe */
.rc-position {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 6px 10px;
  margin: 8px 0 4px;
}

.rc-group {
  font-size: 12px;
  color: #fff;
  font-weight: 600;
}

.rc-rank {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}

/* Journal de raisonnement */
.rc-log-section {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel-title {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.4);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 8px;
}

.rc-log-empty {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  font-style: italic;
}

.rc-log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  max-height: 280px;
}

.rc-log-entry {
  background: rgba(255, 255, 255, 0.04);
  border-left: 2px solid rgba(255, 255, 255, 0.15);
  border-radius: 0 4px 4px 0;
  padding: 5px 8px;
}

.rc-log-meta {
  display: flex;
  justify-content: space-between;
  margin-bottom: 3px;
}

.rc-log-time {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.4);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
}

.rc-log-state {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.rc-log-reason {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.8);
  line-height: 1.4;
}

/* Scrollbar discrète */
.rc-log-list::-webkit-scrollbar { width: 5px; }
.rc-log-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}
</style>
