import type { LyricLine } from './types';

/** Word alignment can correct an approximate provider line start. */
export function currentLyricIndex(lines: LyricLine[], seconds: number): number {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].words?.[0]?.start ?? lines[i].start;
    if (start <= seconds) index = i;
  }
  return index;
}
