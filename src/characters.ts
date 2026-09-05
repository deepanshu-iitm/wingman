/**
 * Flat 2D character avatars ported verbatim from the v2 design canvas.
 *
 * Six hand-drawn SVG symbols (placeholder art). Each person carries ONE
 * character consistently across every screen — the same avatar shows up in the
 * room, the conversation cards, the expanded view and the match celebration.
 * Swap these `<symbol>` bodies for real character art and every avatar in the
 * app updates from this one file.
 */

const CHAR_IDS = ["d", "r", "a", "m", "s", "k"] as const;
export type CharId = (typeof CHAR_IDS)[number];

/** The six symbols, injected once into the DOM so `<use>` can reference them. */
export const CHARACTER_DEFS = `
<svg width="0" height="0" style="position:absolute;overflow:hidden" aria-hidden="true">
  <defs>
    <symbol id="char-d" viewBox="0 0 100 100">
      <path d="M12 100 Q14 76 34 70 L66 70 Q86 76 88 100 Z" fill="#2E8B8B" stroke="#16130E" stroke-width="3.4" stroke-linejoin="round"></path>
      <rect x="43" y="60" width="14" height="14" fill="#F2C79A" stroke="#16130E" stroke-width="3.4"></rect>
      <circle cx="50" cy="42" r="24" fill="#F2C79A" stroke="#16130E" stroke-width="3.4"></circle>
      <path d="M26 36 Q30 14 52 16 Q74 18 74 38 Q66 26 48 27 Q34 28 26 36 Z" fill="#16130E"></path>
      <circle cx="41" cy="43" r="7.5" fill="none" stroke="#16130E" stroke-width="3"></circle>
      <circle cx="60" cy="43" r="7.5" fill="none" stroke="#16130E" stroke-width="3"></circle>
      <path d="M48.5 43 L52.5 43" stroke="#16130E" stroke-width="3"></path>
      <circle cx="41" cy="43" r="3" fill="#16130E"></circle>
      <circle cx="60" cy="43" r="3" fill="#16130E"></circle>
      <path d="M43 55 Q50 61 57 54" fill="none" stroke="#16130E" stroke-width="3.2" stroke-linecap="round"></path>
    </symbol>
    <symbol id="char-r" viewBox="0 0 100 100">
      <path d="M12 100 Q14 76 34 70 L66 70 Q86 76 88 100 Z" fill="#FFB020" stroke="#16130E" stroke-width="3.4" stroke-linejoin="round"></path>
      <rect x="43" y="60" width="14" height="14" fill="#D89A63" stroke="#16130E" stroke-width="3.4"></rect>
      <circle cx="50" cy="42" r="24" fill="#D89A63" stroke="#16130E" stroke-width="3.4"></circle>
      <path d="M25 34 Q28 12 50 12 Q72 12 75 34 L68 34 Q64 24 50 24 Q34 24 32 34 Z" fill="#3A2A1A"></path>
      <circle cx="41" cy="42" r="4.2" fill="#16130E"></circle>
      <circle cx="60" cy="42" r="4.2" fill="#16130E"></circle>
      <path d="M40 51 Q50 47 60 51 Q50 56 40 51 Z" fill="#3A2A1A"></path>
      <path d="M44 58 Q50 62 56 58" fill="none" stroke="#16130E" stroke-width="3" stroke-linecap="round"></path>
    </symbol>
    <symbol id="char-a" viewBox="0 0 100 100">
      <path d="M12 100 Q14 76 34 70 L66 70 Q86 76 88 100 Z" fill="#C9F24D" stroke="#16130E" stroke-width="3.4" stroke-linejoin="round"></path>
      <path d="M22 40 Q22 12 50 12 Q78 12 78 40 L78 78 Q70 66 68 44 Q58 52 50 52 Q42 52 32 44 Q30 66 22 78 Z" fill="#2A1C10"></path>
      <rect x="43" y="60" width="14" height="12" fill="#E8B183" stroke="#16130E" stroke-width="3.4"></rect>
      <circle cx="50" cy="42" r="23" fill="#E8B183" stroke="#16130E" stroke-width="3.4"></circle>
      <path d="M27 34 Q30 15 50 15 Q70 15 73 34 Q62 26 50 26 Q38 26 27 34 Z" fill="#2A1C10"></path>
      <circle cx="41" cy="42" r="4.2" fill="#16130E"></circle>
      <circle cx="60" cy="42" r="4.2" fill="#16130E"></circle>
      <path d="M43 54 Q50 60 57 53" fill="none" stroke="#16130E" stroke-width="3.2" stroke-linecap="round"></path>
      <circle cx="27" cy="52" r="4" fill="#FF5C42" stroke="#16130E" stroke-width="2.4"></circle>
      <circle cx="73" cy="52" r="4" fill="#FF5C42" stroke="#16130E" stroke-width="2.4"></circle>
    </symbol>
    <symbol id="char-m" viewBox="0 0 100 100">
      <path d="M12 100 Q14 76 34 70 L66 70 Q86 76 88 100 Z" fill="#FF5C42" stroke="#16130E" stroke-width="3.4" stroke-linejoin="round"></path>
      <circle cx="50" cy="14" r="11" fill="#4A2E1A" stroke="#16130E" stroke-width="3.2"></circle>
      <rect x="43" y="60" width="14" height="12" fill="#8D5A34" stroke="#16130E" stroke-width="3.4"></rect>
      <circle cx="50" cy="42" r="23" fill="#8D5A34" stroke="#16130E" stroke-width="3.4"></circle>
      <path d="M27 33 Q30 14 50 14 Q70 14 73 33 Q62 25 50 25 Q38 25 27 33 Z" fill="#4A2E1A"></path>
      <rect x="25" y="30" width="50" height="7" rx="3.5" fill="#C9F24D" stroke="#16130E" stroke-width="2.8"></rect>
      <circle cx="41" cy="44" r="4.2" fill="#16130E"></circle>
      <circle cx="60" cy="44" r="4.2" fill="#16130E"></circle>
      <path d="M42 55 Q50 62 58 55" fill="none" stroke="#16130E" stroke-width="3.2" stroke-linecap="round"></path>
    </symbol>
    <symbol id="char-s" viewBox="0 0 100 100">
      <path d="M12 100 Q14 76 34 70 L66 70 Q86 76 88 100 Z" fill="#7B4DFF" stroke="#16130E" stroke-width="3.4" stroke-linejoin="round"></path>
      <rect x="43" y="60" width="14" height="13" fill="#C98D6B" stroke="#16130E" stroke-width="3.4"></rect>
      <circle cx="50" cy="42" r="23" fill="#C98D6B" stroke="#16130E" stroke-width="3.4"></circle>
      <circle cx="33" cy="26" r="11" fill="#16130E"></circle>
      <circle cx="50" cy="19" r="12" fill="#16130E"></circle>
      <circle cx="67" cy="26" r="11" fill="#16130E"></circle>
      <circle cx="41" cy="43" r="4.2" fill="#16130E"></circle>
      <circle cx="60" cy="43" r="4.2" fill="#16130E"></circle>
      <path d="M42 55 L58 55" stroke="#16130E" stroke-width="3.2" stroke-linecap="round"></path>
    </symbol>
    <symbol id="char-k" viewBox="0 0 100 100">
      <path d="M12 100 Q14 76 34 70 L66 70 Q86 76 88 100 Z" fill="#FAF6EF" stroke="#16130E" stroke-width="3.4" stroke-linejoin="round"></path>
      <rect x="43" y="60" width="14" height="13" fill="#F0BE8F" stroke="#16130E" stroke-width="3.4"></rect>
      <circle cx="50" cy="42" r="23" fill="#F0BE8F" stroke="#16130E" stroke-width="3.4"></circle>
      <path d="M27 32 Q27 10 50 10 Q73 10 73 32 Z" fill="#2B44FF" stroke="#16130E" stroke-width="3"></path>
      <rect x="24" y="29" width="52" height="9" rx="4.5" fill="#2B44FF" stroke="#16130E" stroke-width="3"></rect>
      <circle cx="41" cy="45" r="4.2" fill="#16130E"></circle>
      <circle cx="60" cy="45" r="4.2" fill="#16130E"></circle>
      <circle cx="33" cy="52" r="2" fill="#C97A4A"></circle>
      <circle cx="68" cy="52" r="2" fill="#C97A4A"></circle>
      <path d="M43 56 Q50 62 57 56" fill="none" stroke="#16130E" stroke-width="3.2" stroke-linecap="round"></path>
    </symbol>
  </defs>
</svg>`;

/** Stable hash so a given seed always maps to the same character. */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Pick one of the six characters for a person. Deterministic per seed (persona
 * id or name), so the same person keeps the same avatar everywhere.
 */
export function characterFor(seed: string | bigint): CharId {
  const s = typeof seed === "bigint" ? seed.toString() : seed;
  return CHAR_IDS[hashSeed(s || "?") % CHAR_IDS.length];
}

/** An `<svg><use>` avatar chip referencing one of the injected symbols. */
export function avatarSvg(charId: CharId): string {
  return `<svg viewBox="0 0 100 100" class="wg-avatar-svg" aria-hidden="true"><use href="#char-${charId}"></use></svg>`;
}
