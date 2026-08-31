export const PRODUCT_NAME = 'TARS-NG'
export const PRODUCT_COMMAND = 'tars-ng'
export const SUPPORTED_DSH_RELEASE = '0.1.0-rc.8'
export const PRODUCT_CONFIG_SCHEMA_VERSION = 1
export const PRODUCT_STATE_SCHEMA_VERSION = 1
export const DEFAULT_HOME_DIRNAME = 'tars-ng'

export const DEFAULT_LLM_PROVIDER = 'deepseek-official'
export const DEFAULT_LLM_MODEL = 'deepseek-v4-flash'
export const DEFAULT_LLM_CREDENTIAL = 'DEEPSEEK_API_KEY'
export const PRODUCT_UI_SESSION_ID = 'main'
export const DEFAULT_UI_HOST = '127.0.0.1'
export const DEFAULT_UI_PORT = 8787
export const DEFAULT_FEISHU_PROFILE = 'tars-ng'

/** Environment names that may hold secrets. Never log or print their values. */
export const SECRET_ENV_NAMES = [
  'DEEPSEEK_API_KEY',
  'DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN',
  'GOOGLE_SEARCH_API_KEY',
] as const

export const REQUIRED_SECRET_ENV_NAMES = ['DEEPSEEK_API_KEY'] as const

/** Non-secret integration configuration. */
export const CONFIG_ENV_NAMES = [
  'GOOGLE_SEARCH_ENGINE_ID',
  'DSH_ASSISTANT_GOOGLE_CALENDAR_MODE',
  'DSH_ASSISTANT_FEISHU_MODE',
  'DSH_ASSISTANT_FEISHU_PROFILE',
  'DSH_ASSISTANT_FEISHU_CALENDAR_MODE',
  'DSH_ASSISTANT_SANDBOX_ROOT',
  'DSH_ASSISTANT_KNOWLEDGE_OBSIDIAN_VAULT',
  'TARS_NG_ALLOW_FIXTURES',
  'TARS_NG_PROFILE',
  'TARS_NG_WORKSPACE',
  'TARS_NG_SESSION_ROOT',
  'TARS_NG_SESSION_ID',
] as const

export const DSH_RUNTIME_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
] as const
