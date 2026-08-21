const SECRET = /bearer\s+[a-z0-9._~+/=-]+|ya29\.[0-9a-z._-]+|access_token=[^&\s]+|refresh_token=[^&\s]+|client_secret=[^&\s]+|authorization:\s*\S+/gi

/** Strip tokens, secrets, and credential-bearing URLs from provider diagnostics. */
export function sanitizeProviderError(message: string): string {
  return message
    .replace(SECRET, '[redacted]')
    .replace(/https:\/\/[^/\s]+\/calendar\/v3[^\s]*/gi, 'https://www.googleapis.com/calendar/v3')
}
