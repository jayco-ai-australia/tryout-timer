/**
 * Shared by the Add user form and its server route (app/admin/users/route.ts), so the length the
 * form asks for is the length the server enforces.
 */

export const MIN_PASSWORD_LENGTH = 10

/** No 0/O, 1/l/I: the password gets read out across a desk. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/**
 * Three groups of four from ALPHABET, e.g. "k7mp-x3qd-9hzt": about 59 bits, easy to read aloud.
 * Uses crypto.getRandomValues with rejection sampling so no character is likelier than another.
 */
export function generatePassword(): string {
  const chars: string[] = []
  const limit = 256 - (256 % ALPHABET.length)
  const buf = new Uint8Array(1)
  while (chars.length < 12) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) chars.push(ALPHABET[buf[0] % ALPHABET.length])
  }
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join('')).join('-')
}
