/**
 * Type-prefixed, ULID-based ids. ULIDs are lexicographically sortable, so an
 * id doubles as a cursor — `?since=<ayoId>` returns everything after it.
 * See ADR 0002.
 */

export type UserId = `user_${string}`;
export type TeamId = `team_${string}`;
export type AyoId = `ayo_${string}`;

export type IdPrefix = "user" | "team" | "ayo";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = CROCKFORD.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/**
 * Minimal dependency-free ULID generator. Monotonic within the same
 * millisecond is NOT guaranteed here — collisions are vanishingly unlikely for
 * Ayo's volume, but a production relay should use a monotonic factory.
 */
export function ulid(now: number = Date.now()): string {
  let time = now;
  const timeChars: string[] = new Array(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    timeChars[i] = CROCKFORD[time % ENCODING_LEN]!;
    time = Math.floor(time / ENCODING_LEN);
  }

  const randomChars: string[] = new Array(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i++) {
    randomChars[i] = CROCKFORD[Math.floor(Math.random() * ENCODING_LEN)]!;
  }

  return timeChars.join("") + randomChars.join("");
}

function newId<P extends IdPrefix>(prefix: P, now?: number): `${P}_${string}` {
  return `${prefix}_${ulid(now)}`;
}

export const newUserId = (now?: number): UserId => newId("user", now);
export const newTeamId = (now?: number): TeamId => newId("team", now);
export const newAyoId = (now?: number): AyoId => newId("ayo", now);
