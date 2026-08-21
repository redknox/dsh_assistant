export const PRODUCT_NAME = 'TARS-NG'
export const PRODUCT_COMMAND = 'tars-ng'
export const SUPPORTED_DSH_RELEASE = '0.1.0-rc.8'
export const PRODUCT_CONFIG_SCHEMA_VERSION = 1
export const PRODUCT_STATE_SCHEMA_VERSION = 1
export const DEFAULT_HOME_DIRNAME = 'tars-ng'

/** Environment names that may hold secrets. Never log or print their values. */
export const SECRET_ENV_NAMES = [
  'DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN',
  'GOOGLE_SEARCH_API_KEY',
] as const

/** Non-secret integration configuration. */
export const CONFIG_ENV_NAMES = [
  'GOOGLE_SEARCH_ENGINE_ID',
  'DSH_ASSISTANT_GOOGLE_CALENDAR_MODE',
  'TARS_NG_ALLOW_FIXTURES',
] as const

export const DSH_RUNTIME_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
] as const
