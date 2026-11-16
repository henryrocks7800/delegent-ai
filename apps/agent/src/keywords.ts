/** The meaningful words of a recall question (see recall.ts). */
const STOP_WORDS = new Set(
  'about above after again all also and any are asked before but can chat could did does earlier fresh from had has have her his how into just last mention mentioned more most my our out over previous remember said she should some than that the their them then there these they this those told topic under very was were what when where which while who why will with would you your yesterday today conversation conversations talked talk'.split(
    ' '
  )
);

export function recallKeywords(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}£$€]{3,}/gu) ?? [];
  return [...new Set(words)].filter((w) => !STOP_WORDS.has(w)).slice(0, 8);
}
