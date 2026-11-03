// Font declarations are independent scalar style properties. A nearer direct
// name or theme reference replaces the same slot, never the other three slots.
export const FONT_SLOTS = Object.freeze({ fontAscii: 'ascii', fontHAnsi: 'hAnsi', fontEastAsia: 'eastAsia', fontCs: 'cs' });
export const FONT_DEFAULTS = Object.freeze({ fontAscii: 'Noto Sans', fontHAnsi: 'Noto Sans', fontEastAsia: 'Noto Sans', fontCs: 'Noto Sans', fontHint: 'default', fontLanguage: '', fontEastAsiaLanguage: '', fontBidiLanguage: '', fontEastAsiaCharset: '' });
export const isBundledFont = name => !name || name.trim().toLowerCase() === 'noto sans';
export function checkedFontName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 253 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('A font name must contain 1–253 printable characters.');
  return value;
}
export function checkedFontProperty(key, value) {
  if (Object.hasOwn(FONT_SLOTS, key)) return checkedFontName(value);
  if (key === 'fontHint') { if (!['default', 'eastAsia', 'cs'].includes(value)) throw new Error('Invalid font hint.'); }
  else if (key === 'fontEastAsiaCharset') { if (value !== '' && !/^[0-9a-f]{2}$/i.test(value)) throw new Error('Invalid font character set.'); }
  else if (typeof value !== 'string' || value.length > 85 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Invalid font language.');
  return value;
}
export function checkedFontEdit(key, value) {
  if (key === 'fontEastAsiaCharset') throw new Error('Font character sets come from the document font table.');
  if (key.endsWith('Language') && value === '') throw new Error('Choose a language or remove the style declaration to inherit it.');
  return checkedFontProperty(key, value);
}

const inRange = (c, a, b) => c >= a && c <= b;
// MS-OI29500 §2.1.88, implementation note for §17.3.2.26. This is the
// published font classification, not the Unicode Script property. A grapheme
// keeps its base character's family so combining marks and emoji stay shaped.
export function fontSlot(text, style) {
  if (style.cs || style.rtl) return 'fontCs';
  if (style.fontEastAsia === 'Times New Roman' && style.fontAscii === style.fontHAnsi) return 'fontAscii';
  const c = text.codePointAt(0) ?? 0;
  if (c <= 0x7f || inRange(c, 0x590, 0x7bf) || inRange(c, 0xfb1d, 0xfdff) || inRange(c, 0xfe70, 0xfefe)) return 'fontAscii';
  if (inRange(c, 0x1100, 0x11ff) || inRange(c, 0x2f00, 0x2fdf) || inRange(c, 0x2ff0, 0x4dbf) || inRange(c, 0x4e00, 0x9faf) || inRange(c, 0xa000, 0xa4cf) || inRange(c, 0xac00, 0xd7af) || inRange(c, 0xd800, 0xdfff) || c > 0xffff || inRange(c, 0xf900, 0xfaff) || inRange(c, 0xfe30, 0xfe6f) || inRange(c, 0xff00, 0xffef)) return 'fontEastAsia';
  if (style.fontHint === 'eastAsia') {
    const chinese = /^zh(?:-|$)/i.test(style.fontEastAsiaLanguage || style.fontLanguage || '');
    if (inRange(c, 0x2b0, 0x3cf) || inRange(c, 0x400, 0x4ff) || inRange(c, 0x2000, 0x27bf) || inRange(c, 0x2e80, 0x2eff) || inRange(c, 0xe000, 0xf8ff) || inRange(c, 0xfb00, 0xfb1c)) return 'fontEastAsia';
    if (inRange(c, 0x100, 0x2af) && (chinese || /^(86|88)$/i.test(style.fontEastAsiaCharset || '')) || inRange(c, 0x1e00, 0x1eff) && chinese) return 'fontEastAsia';
    if ([0xa1, 0xa4, 0xa7, 0xa8, 0xaa, 0xad, 0xaf, 0xd7, 0xf7].includes(c) || inRange(c, 0xb0, 0xb4) || inRange(c, 0xb6, 0xba) || inRange(c, 0xbc, 0xbf)) return 'fontEastAsia';
    if (chinese && (inRange(c, 0xe0, 0xe1) || inRange(c, 0xe8, 0xea) || inRange(c, 0xec, 0xed) || inRange(c, 0xf2, 0xf3) || inRange(c, 0xf9, 0xfa) || c === 0xfc)) return 'fontEastAsia';
  }
  return 'fontHAnsi';
}
export function textFontStyle(text, style) {
  const result = { ...style, fontFamily: style[fontSlot(text, style)] || 'Noto Sans' };
  if (style.cs || style.rtl) {
    result.bold = style.boldCs ?? false;
    result.italic = style.italicCs ?? false;
    result.fontSize = style.fontSizeCs ?? 12;
    // Native RTL controls use the upright face with a 1/3 shear even when a
    // real italic face exists. Plain cs uses ordinary face matching instead.
    // Keep this a display property; source i/iCs declarations remain separate.
    if (style.rtl && result.italic) { result.italic = false; result.syntheticItalic = true; }
  }
  return result;
}
export const cssFontString = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
export const canvasFontFamily = style => {
  const family = (style.fontFamily || style.fontAscii || 'Noto Sans').trim();
  return isBundledFont(family) ? '"Canvas Noto Sans"' : `${cssFontString(family)}, "Canvas Noto Sans"`;
};
