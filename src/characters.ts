/**
 * Avatar system powered by DiceBear HTTP API (api.dicebear.com/9.x).
 * Deterministic per seed with gender-aware style pools — every person
 * keeps the same avatar across all screens, and different users within
 * the same gender each get a distinct look.
 *
 * Swap styleFor() pools or add DiceBear options to change the aesthetic.
 */

export type CharId = string; // kept for backward-compat call sites

/** No-op — DiceBear serves avatars via HTTP; no DOM injection needed. */
export const CHARACTER_DEFS = "";

const WOMAN_STYLES = ["lorelei", "adventurer", "big-smile"] as const;
const MAN_STYLES   = ["big-ears", "adventurer-neutral", "micah"] as const;
const NB_STYLES    = ["notionists-neutral", "micah", "thumbs"] as const;
const ANY_STYLES   = [...WOMAN_STYLES, ...MAN_STYLES, ...NB_STYLES] as const;

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

function styleFor(seed: string, gender?: string): string {
  const h = hashSeed(seed);
  if (gender === "Woman")     return WOMAN_STYLES[h % WOMAN_STYLES.length];
  if (gender === "Man")       return MAN_STYLES[h % MAN_STYLES.length];
  if (gender === "Nonbinary") return NB_STYLES[h % NB_STYLES.length];
  return ANY_STYLES[h % ANY_STYLES.length];
}

/** DiceBear avatar URL — seed drives all feature variation within the style. */
export function avatarUrl(seed: string | bigint, gender?: string): string {
  const s = typeof seed === "bigint" ? seed.toString() : (seed || "?");
  const style = styleFor(s, gender);
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(s)}`;
}

/** <img> element embedding a DiceBear avatar, ready for innerHTML. */
export function avatarSvg(seed: string | bigint | CharId, gender?: string): string {
  const s = typeof seed === "bigint" ? seed.toString() : ((seed as string) || "?");
  return `<img src="${avatarUrl(s, gender)}" class="wg-avatar-svg" alt="" loading="lazy" draggable="false" />`;
}

/**
 * Returns the seed string for a person — kept so existing
 * `avatarSvg(characterFor(seed))` call sites continue to work unchanged.
 * @deprecated Pass seed directly to avatarSvg(seed, gender).
 */
export function characterFor(seed: string | bigint): CharId {
  return typeof seed === "bigint" ? seed.toString() : (seed || "?");
}
