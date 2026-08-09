const STORAGE_KEY = 'nas-vocrep:v04:settings'

export const DEFAULT_APP_SETTINGS = Object.freeze({
  outputMode: 'source',
  outputDirectory: '',
  namingMode: 'detailed',
  defaultSampleRate: 48000,
  defaultOutputDepth: 24,
  openOutputFolderAfterProcess: false,
})

const VALID_SAMPLE_RATES = new Set([44100, 48000, 96000])
const VALID_DEPTHS = new Set([16, 24, 32])
const VALID_OUTPUT_MODES = new Set(['source', 'custom'])
const VALID_NAMING_MODES = new Set(['detailed', 'compact'])

export function normalizeAppSettings(value = {}) {
  return {
    outputMode: VALID_OUTPUT_MODES.has(value.outputMode) ? value.outputMode : DEFAULT_APP_SETTINGS.outputMode,
    outputDirectory: typeof value.outputDirectory === 'string' ? value.outputDirectory : '',
    namingMode: VALID_NAMING_MODES.has(value.namingMode) ? value.namingMode : DEFAULT_APP_SETTINGS.namingMode,
    defaultSampleRate: VALID_SAMPLE_RATES.has(Number(value.defaultSampleRate)) ? Number(value.defaultSampleRate) : DEFAULT_APP_SETTINGS.defaultSampleRate,
    defaultOutputDepth: VALID_DEPTHS.has(Number(value.defaultOutputDepth)) ? Number(value.defaultOutputDepth) : DEFAULT_APP_SETTINGS.defaultOutputDepth,
    openOutputFolderAfterProcess: Boolean(value.openOutputFolderAfterProcess),
  }
}

export function loadAppSettings() {
  if (typeof window === 'undefined') return { ...DEFAULT_APP_SETTINGS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? normalizeAppSettings(JSON.parse(raw)) : { ...DEFAULT_APP_SETTINGS }
  } catch {
    return { ...DEFAULT_APP_SETTINGS }
  }
}

export function saveAppSettings(settings) {
  const normalized = normalizeAppSettings(settings)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  }
  return normalized
}
