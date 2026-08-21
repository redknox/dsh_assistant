const SECRET = /bearer\s+[a-z0-9._~+/=-]+|ya29\.[0-9a-z._-]+|access_token=[^&\s]+|refresh_token=[^&\s]+|client_secret=[^&\s]+|authorization:\s*\S+/gi

export function sanitizeProviderError(message) {
  return String(message)
    .replace(SECRET, '[redacted]')
    .replace(/https:\/\/[^/\s]+\/calendar\/v3[^\s]*/gi, 'https://www.googleapis.com/calendar/v3')
}
