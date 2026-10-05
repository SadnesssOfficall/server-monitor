export const LIMITS = {
  name: { max: 100 },
  target: { max: 2048 },
  interval: { min: 10, max: 86_400, fallback: 60 },
  timeout: { min: 500, max: 60_000, fallback: 10_000 },
  status: { min: 100, max: 599 },
  redirects: { min: 0, max: 10, fallback: 5 },
  failureThreshold: { min: 1, max: 20, fallback: 3 },
  recoveryThreshold: { min: 1, max: 20, fallback: 1 },
  keyword: { max: 200 },
  bodyBytes: { min: 1024, max: 1_048_576, fallback: 262_144 },
  certWarnDays: { min: 0, max: 365, fallback: 14 },
  cooldown: { min: 0, max: 86_400, fallback: 900 },
  channelIds: { max: 20 },
  recipients: { max: 20 },
  secret: { min: 16, max: 256 },
  credential: { max: 256 },
  port: { min: 1, max: 65_535 },
} as const;

export const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
