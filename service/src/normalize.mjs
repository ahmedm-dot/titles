// Accent/case-insensitive normalization used for de-duplicating suggestions and cache keys.
export function norm(s) {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')       // strip Latin diacritics
    .replace(/[ً-ْـ]/g, '')                    // strip Arabic harakat + tatweel
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه') // Arabic letter variants
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
