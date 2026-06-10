<template>
  <div class="altimetric-profile">
    <div class="profile-label">Profil d'étape</div>
    <svg :width="width" :height="svgHeight" class="profile-svg">
      <defs>
        <linearGradient id="altGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.35" />
          <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.04" />
        </linearGradient>
        <clipPath id="profileClip">
          <rect :width="width" :height="svgHeight" />
        </clipPath>
      </defs>

      <!-- Grille horizontale légère -->
      <g v-for="line in gridLines" :key="line.y">
        <line :x1="0" :y1="line.y" :x2="width" :y2="line.y"
              stroke="white" stroke-opacity="0.05" stroke-width="1" />
        <text :x="4" :y="line.y - 2" font-size="8" fill="white" fill-opacity="0.3">
          {{ line.alt }}m
        </text>
      </g>

      <!-- Surface altimétrique -->
      <polygon v-if="fillPoints" :points="fillPoints" fill="url(#altGrad)" clip-path="url(#profileClip)" />

      <!-- Ligne du profil colorée par gradient -->
      <g clip-path="url(#profileClip)">
        <line
          v-for="(seg, i) in coloredSegments"
          :key="i"
          :x1="seg.x1" :y1="seg.y1"
          :x2="seg.x2" :y2="seg.y2"
          :stroke="seg.color"
          stroke-width="2"
          stroke-linecap="round"
        />
      </g>

      <!-- Zone déjà parcourue (overlay sombre) -->
      <rect
        v-if="posX > 0"
        x="0" :y="0"
        :width="posX"
        :height="svgHeight"
        fill="black"
        fill-opacity="0.25"
        clip-path="url(#profileClip)"
      />

      <!-- Points clés -->
      <g v-for="kp in keyPointsRendered" :key="kp.km">
        <line :x1="kp.x" y1="0" :x2="kp.x" :y2="svgHeight"
              stroke="white" stroke-opacity="0.2" stroke-width="1" stroke-dasharray="3,2" />
        <text :x="kp.x" y="10" text-anchor="middle" font-size="8" fill="white" fill-opacity="0.55">
          {{ kp.type === 'summit' ? '▲' : kp.type === 'sprint' ? '⚡' : '🏁' }}
        </text>
      </g>

      <!-- Ligne position courante -->
      <line v-if="posX !== null"
        :x1="posX" y1="0" :x2="posX" :y2="svgHeight"
        stroke="#fbbf24" stroke-width="1.5" stroke-dasharray="4,3" />

      <!-- Marqueur position -->
      <circle v-if="posX !== null" :cx="posX" :cy="posY" r="4" fill="#fbbf24" />
    </svg>

    <!-- Infos -->
    <div class="profile-info">
      <span class="info-item">
        <span class="info-label">Alt</span>
        <span class="info-value">{{ currentAlt }}m</span>
      </span>
      <span class="info-item">
        <span class="info-label">Pente</span>
        <span class="info-value" :style="{ color: gradientColor }">
          {{ currentGradientStr }}%
        </span>
      </span>
      <span class="info-item">
        <span class="info-label">Parcouru</span>
        <span class="info-value">{{ kmDone }}km</span>
      </span>
      <span class="info-item">
        <span class="info-label">Restant</span>
        <span class="info-value">{{ kmRemaining }}km</span>
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  track:     { type: Object, required: true },
  spline:    { type: Object, default: null },   // CatmullRomSpline instance
  splinePos: { type: Number, default: 0 },
  width:     { type: Number, default: 550 },
  svgHeight: { type: Number, default: 60 },
})

const PAD = { top: 10, bottom: 4, left: 0, right: 0 }

// Points de profil projetés sur le SVG
const profilePoints = computed(() => {
  const pts = props.track?.points
  if (!pts?.length) return []
  const alts = pts.map(p => p.alt)
  const minAlt = Math.min(...alts)
  const maxAlt = Math.max(...alts)
  const range  = maxAlt - minAlt || 1
  const totalKm = props.track.distance_km

  return pts.map(p => ({
    x:   (p.km / totalKm) * props.width,
    y:   props.svgHeight - PAD.bottom - ((p.alt - minAlt) / range) * (props.svgHeight - PAD.top - PAD.bottom),
    alt: p.alt,
    km:  p.km,
    gradient: 0,
  }))
})

const fillPoints = computed(() => {
  if (!profilePoints.value.length) return ''
  const first = profilePoints.value[0]
  const last  = profilePoints.value[profilePoints.value.length - 1]
  const path  = profilePoints.value.map(p => `${p.x},${p.y}`).join(' ')
  return `${first.x},${props.svgHeight} ${path} ${last.x},${props.svgHeight}`
})

// Segments colorés selon gradient réel
const coloredSegments = computed(() => {
  const pts = profilePoints.value
  if (pts.length < 2) return []
  return pts.slice(0, -1).map((p, i) => {
    const next = pts[i + 1]
    const dAlt = next.alt - p.alt
    const dKm  = (next.km - p.km) * 1000  // en mètres
    const grad = dKm > 0 ? (dAlt / dKm) * 100 : 0
    return { x1: p.x, y1: p.y, x2: next.x, y2: next.y, color: gradColor(grad) }
  })
})

function gradColor(g) {
  if (g > 8)  return '#7c3aed'
  if (g > 5)  return '#ef4444'
  if (g > 2)  return '#f97316'
  if (g > 0)  return '#fbbf24'
  if (g < -3) return '#60a5fa'
  return '#6b7280'
}

// Grille d'altitude
const gridLines = computed(() => {
  const alts = props.track?.points?.map(p => p.alt) ?? []
  if (!alts.length) return []
  const minAlt = Math.min(...alts)
  const maxAlt = Math.max(...alts)
  const range  = maxAlt - minAlt || 1
  const step   = range > 200 ? 100 : range > 100 ? 50 : 25
  const lines  = []
  for (let a = Math.ceil(minAlt / step) * step; a <= maxAlt; a += step) {
    const y = props.svgHeight - PAD.bottom - ((a - minAlt) / range) * (props.svgHeight - PAD.top - PAD.bottom)
    lines.push({ y, alt: a })
  }
  return lines
})

// Position courante sur le profil
// On utilise la spline pour convertir splinePos → km réel si disponible
const currentKm = computed(() => {
  if (props.spline?.getKmAt) return props.spline.getKmAt(props.splinePos)
  // Fallback : ratio splinePos / totalLength * distance_km
  if (props.spline?.totalLength) {
    return (props.splinePos / props.spline.totalLength) * props.track.distance_km
  }
  return 0
})

const progress = computed(() => Math.min(1, currentKm.value / props.track.distance_km))

const posX = computed(() => progress.value * props.width)

const posY = computed(() => {
  const pts = profilePoints.value
  if (!pts.length) return props.svgHeight / 2
  // Interpoler la hauteur Y pour le km courant
  const km = currentKm.value
  for (let i = 0; i < pts.length - 1; i++) {
    if (km >= pts[i].km && km <= pts[i+1].km) {
      const t = (km - pts[i].km) / (pts[i+1].km - pts[i].km)
      return pts[i].y + (pts[i+1].y - pts[i].y) * t
    }
  }
  return pts[pts.length - 1].y
})

const currentAlt = computed(() => {
  if (props.spline?.getAltAt) return Math.round(props.spline.getAltAt(props.splinePos))
  return 0
})

const currentGradient = computed(() => {
  if (props.spline?.getGradientAt) return props.spline.getGradientAt(props.splinePos)
  return 0
})

const currentGradientStr = computed(() => {
  const g = currentGradient.value
  return (g >= 0 ? '+' : '') + g.toFixed(1)
})

const gradientColor = computed(() => gradColor(currentGradient.value))

const kmDone      = computed(() => currentKm.value.toFixed(1))
const kmRemaining = computed(() => Math.max(0, props.track.distance_km - currentKm.value).toFixed(1))

const keyPointsRendered = computed(() =>
  (props.track?.keyPoints ?? []).map(kp => ({
    ...kp,
    x: (kp.km / props.track.distance_km) * props.width,
  }))
)
</script>

<style scoped>
.altimetric-profile {
  background: rgba(0,0,0,0.72);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  padding: 6px 10px 5px;
  backdrop-filter: blur(6px);
}
.profile-label {
  font-size: 9px;
  color: rgba(255,255,255,0.35);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 3px;
}
.profile-svg { display: block; }
.profile-info {
  display: flex;
  gap: 14px;
  margin-top: 4px;
}
.info-item   { display: flex; gap: 4px; align-items: baseline; }
.info-label  { font-size: 9px; color: rgba(255,255,255,0.38); text-transform: uppercase; }
.info-value  { font-size: 11px; color: #fff; font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
