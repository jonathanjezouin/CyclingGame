<template>
  <div class="altimetric-profile">
    <div class="profile-label">Profil d'étape</div>
    <svg
      :width="width"
      :height="height"
      class="profile-svg"
    >
      <!-- Zone de remplissage sous le profil -->
      <defs>
        <linearGradient id="altGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.4" />
          <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.05" />
        </linearGradient>
      </defs>

      <!-- Surface altimétrique -->
      <polygon
        v-if="profilePath"
        :points="fillPoints"
        fill="url(#altGrad)"
      />

      <!-- Ligne du profil -->
      <polyline
        v-if="profilePath"
        :points="profilePath"
        fill="none"
        stroke="#60a5fa"
        stroke-width="1.5"
      />

      <!-- Ligne de position courante -->
      <line
        v-if="posX !== null"
        :x1="posX"
        y1="0"
        :x2="posX"
        :y2="height"
        stroke="#fbbf24"
        stroke-width="1.5"
        stroke-dasharray="3,2"
      />

      <!-- Marqueur position -->
      <circle
        v-if="posX !== null"
        :cx="posX"
        :cy="posY"
        r="3"
        fill="#fbbf24"
      />

      <!-- Points clés -->
      <g v-for="kp in keyPointsRendered" :key="kp.km">
        <line
          :x1="kp.x" y1="4"
          :x2="kp.x" :y2="height - 4"
          stroke="#ffffff"
          stroke-width="0.5"
          stroke-opacity="0.3"
        />
        <text
          :x="kp.x"
          y="10"
          text-anchor="middle"
          font-size="7"
          fill="#ffffff"
          fill-opacity="0.6"
        >{{ kp.name }}</text>
      </g>
    </svg>

    <!-- Infos texte -->
    <div class="profile-info">
      <span class="info-item">
        <span class="info-label">Alt</span>
        <span class="info-value">{{ currentAlt }}m</span>
      </span>
      <span class="info-item">
        <span class="info-label">Pente</span>
        <span class="info-value" :style="{ color: gradientColor }">{{ currentGradient }}%</span>
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
  track: { type: Object, required: true },
  splinePos: { type: Number, default: 0 },
  width: { type: Number, default: 500 },
  height: { type: Number, default: 60 },
})

const profilePoints = computed(() => {
  if (!props.track?.points?.length) return []
  const pts = props.track.points
  const totalKm = props.track.distance_km
  const alts = pts.map(p => p.alt)
  const minAlt = Math.min(...alts)
  const maxAlt = Math.max(...alts)
  const range = maxAlt - minAlt || 1
  const pad = 8

  return pts.map(p => ({
    x: (p.km / totalKm) * props.width,
    y: props.height - pad - ((p.alt - minAlt) / range) * (props.height - pad * 2),
    alt: p.alt,
    km: p.km,
  }))
})

const profilePath = computed(() =>
  profilePoints.value.map(p => `${p.x},${p.y}`).join(' ')
)

const fillPoints = computed(() => {
  if (!profilePoints.value.length) return ''
  const first = profilePoints.value[0]
  const last = profilePoints.value[profilePoints.value.length - 1]
  return `${first.x},${props.height} ${profilePath.value} ${last.x},${props.height}`
})

const currentProgress = computed(() => {
  const totalM = props.track.distance_km * 1000
  return Math.min(1, props.splinePos / totalM)
})

const posX = computed(() => currentProgress.value * props.width)

const posY = computed(() => {
  if (!profilePoints.value.length) return props.height / 2
  const idx = Math.floor(currentProgress.value * (profilePoints.value.length - 1))
  return profilePoints.value[Math.min(idx, profilePoints.value.length - 1)]?.y ?? props.height / 2
})

const currentAlt = computed(() => {
  if (!profilePoints.value.length) return 0
  const idx = Math.floor(currentProgress.value * (profilePoints.value.length - 1))
  return profilePoints.value[Math.min(idx, profilePoints.value.length - 1)]?.alt ?? 0
})

const currentGradient = computed(() => {
  const pts = profilePoints.value
  if (pts.length < 2) return '0.0'
  const idx = Math.min(Math.floor(currentProgress.value * (pts.length - 1)), pts.length - 2)
  const dAlt = pts[idx + 1].alt - pts[idx].alt
  const dKm = (pts[idx + 1].km - pts[idx].km) * 1000
  if (dKm === 0) return '0.0'
  return ((dAlt / dKm) * 100).toFixed(1)
})

const gradientColor = computed(() => {
  const g = parseFloat(currentGradient.value)
  if (g > 8) return '#7c3aed'
  if (g > 5) return '#ef4444'
  if (g > 2) return '#f97316'
  if (g > 0) return '#fbbf24'
  if (g < -3) return '#60a5fa'
  return '#9ca3af'
})

const kmRemaining = computed(() => {
  const totalM = props.track.distance_km * 1000
  const rem = (totalM - props.splinePos) / 1000
  return Math.max(0, rem).toFixed(1)
})

const keyPointsRendered = computed(() => {
  if (!props.track?.keyPoints) return []
  return props.track.keyPoints.map(kp => ({
    ...kp,
    x: (kp.km / props.track.distance_km) * props.width,
  }))
})
</script>

<style scoped>
.altimetric-profile {
  background: rgba(0, 0, 0, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 6px 10px 4px;
  backdrop-filter: blur(4px);
}

.profile-label {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.4);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 4px;
}

.profile-svg {
  display: block;
}

.profile-info {
  display: flex;
  gap: 16px;
  margin-top: 4px;
}

.info-item {
  display: flex;
  gap: 4px;
  align-items: baseline;
}

.info-label {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.4);
  text-transform: uppercase;
}

.info-value {
  font-size: 11px;
  color: #ffffff;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
