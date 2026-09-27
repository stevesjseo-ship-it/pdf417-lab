// pdf417Math.js — deterministic PDF417 mathematics for the PDF417 Dissector / Codeword Lab.
//
// Pure ES module: no DOM, no network, no AI, no dependencies. Runs in browsers,
// Web Workers, Node >= 18 and Deno.
//
// House rules (enforced by tests — see README.md):
//  1. Decimal identifiers (full27, A, B, item, D, E_long, E_short) are STRINGS of
//     ASCII digits. Passing a JavaScript Number throws: Numbers lose leading
//     zeros, and a 27-digit value cannot be represented exactly as a Number.
//  2. Big integers are BigInt internally. Big values returned inside result
//     objects are decimal strings, so results survive JSON.stringify.
//  3. Codeword values (0..928), run widths, row/column indices are small Numbers.
//  4. Nothing is guessed. Invalid input throws Pdf417MathError with a stable code.
//  5. Every conversion to Number is annotated "safe-number:" (a test enforces it).
//  6. The PDF417 codeword<->pattern table is NOT bundled and must never be typed
//     by hand. Load it from ZXing with patternTableFrom*().

export const MODULE_VERSION = '1.0.0';

// ───────────────────────────── errors & validation ─────────────────────────────

export class Pdf417MathError extends Error {
  constructor(code, message, details) {
    super(`[${code}] ${message}`);
    this.name = 'Pdf417MathError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new Pdf417MathError(code, message, details);
}

const DIGITS_RE = /^[0-9]+$/;

function requireDigitString(value, name, exactLength) {
  if (typeof value !== 'string') {
    fail('E_NOT_STRING', `${name} must be a string of decimal digits, got ${typeof value}. ` +
      'Numbers drop leading zeros and cannot hold 27 digits exactly.', { value: String(value) });
  }
  if (!DIGITS_RE.test(value)) fail('E_NOT_DIGITS', `${name} must contain only ASCII digits 0-9`, { value });
  if (exactLength !== undefined && value.length !== exactLength) {
    fail('E_LENGTH', `${name} must be exactly ${exactLength} digits (got ${value.length})`, { value });
  }
  return value;
}

function requireInt(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('E_RANGE', `${name} must be an integer ${min}..${max}`, { value });
  }
  return value;
}

function isArrayLike(x) {
  return Array.isArray(x) || (ArrayBuffer.isView(x) && !(x instanceof DataView));
}

function requireIntArray(arr, name, min, max) {
  if (!isArrayLike(arr)) fail('E_NOT_ARRAY', `${name} must be an array`);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = requireInt(arr[i], `${name}[${i}]`, min, max);
  return out;
}

function smallIntFromDigits(s) {
  // Only ever called on validated digit strings of length <= 15.
  if (s.length > 15) fail('E_INTERNAL', 'smallIntFromDigits used on a long value');
  return Number(s); // safe-number: <= 15 validated digits, exactly representable
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !ArrayBuffer.isView(o)) {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

// ────────────────────────────────── constants ──────────────────────────────────

export const PDF417 = deepFreeze({
  MODULES_PER_CODEWORD: 17,
  RUNS_PER_CODEWORD: 8,
  MIN_RUN: 1,
  MAX_RUN: 6,
  CODEWORD_VALUES: 929,               // values 0..928
  FIELD_PRIME: 929,                   // Reed-Solomon over GF(929)
  NUMERIC_MAX_DIGITS_PER_GROUP: 44,
  NUMERIC_MAX_CODEWORDS_PER_GROUP: 15,
  MIN_ROWS: 3, MAX_ROWS: 90, MIN_COLS: 1, MAX_COLS: 30,
  MAX_SYMBOL_CODEWORDS: 928,          // rows x cols, excluding row indicators
  START_RUNS: [8, 1, 1, 1, 1, 1, 1, 3],
  STOP_RUNS: [7, 1, 1, 3, 1, 1, 1, 2, 1],
  START_PATTERN_INT: 0x1fea8,
  STOP_PATTERN_INT: 0x3fa29,
  CLUSTERS: [0, 3, 6],
});

export const CONTROL_CODEWORDS = deepFreeze({
  900: { name: 'TEXT_COMPACTION_LATCH', meaning: 'Latch to Text Compaction mode (also the pad codeword)' },
  901: { name: 'BYTE_COMPACTION_LATCH', meaning: 'Latch to Byte Compaction mode (byte count not a multiple of 6)' },
  902: { name: 'NUMERIC_COMPACTION_LATCH', meaning: 'Latch to Numeric Compaction mode (inside numeric mode: ends the current group)' },
  913: { name: 'BYTE_SHIFT', meaning: 'Shift to Byte Compaction for the next single codeword' },
  922: { name: 'MACRO_TERMINATOR', meaning: 'Macro PDF417 terminator' },
  923: { name: 'MACRO_OPTIONAL_FIELD', meaning: 'Macro PDF417 optional field designator' },
  924: { name: 'BYTE_COMPACTION_LATCH_6', meaning: 'Latch to Byte Compaction mode (byte count a multiple of 6)' },
  925: { name: 'ECI_USER_DEFINED', meaning: 'ECI user-defined (followed by 1 codeword)' },
  926: { name: 'ECI_GENERAL_PURPOSE', meaning: 'ECI general purpose (followed by 2 codewords)' },
  927: { name: 'ECI_CHARACTER_SET', meaning: 'ECI character set (followed by 1 codeword)' },
  928: { name: 'MACRO_CONTROL_BLOCK', meaning: 'Begin Macro PDF417 control block' },
});

/** Acceptance record from the specification. Used by the UI "Load Known Test" button. */
export const KNOWN_TEST = deepFreeze({
  full27: '171811492360069186481244870',
  A: '1718', B: '1149236', C: 2, item: '006', D: '918648124', E_long: '4870', E_short: '885',
  base900WithSentinel: '1171811492360069186481244870',
  N: [3, 22, 166, 657, 504, 495, 626, 774, 338, 670],
  dataStream: [12, 902, 3, 22, 166, 657, 504, 495, 626, 774, 338, 670],
  ecLevel: 2,
  errorCorrection: [452, 170, 213, 366, 511, 345, 618, 301],
  rows: 4, cols: 5,
  layout: [[12, 902, 3, 22, 166], [657, 504, 495, 626, 774], [338, 670, 452, 170, 213], [366, 511, 345, 618, 301]],
  cSelectorValue: 166,
  dPath: [670, 22, 338, 626, 504, 338, 22, 166, 504],
  ePath: [504, 338, 774, 3],
});

// ─────────────────────────── 27-digit study format ─────────────────────────────

export const STUDY_FORMAT = deepFreeze({
  LENGTH: 27,
  FIELDS: [
    { name: 'A', start: 0, length: 4 },
    { name: 'B', start: 4, length: 7 },
    { name: 'item', start: 11, length: 3 },
    { name: 'D', start: 14, length: 9 },
    { name: 'E_long', start: 23, length: 4 },
  ],
});

export function parse27(full27) {
  requireDigitString(full27, 'full27', 27);
  return {
    full27,
    A: full27.slice(0, 4),
    B: full27.slice(4, 11),
    item: full27.slice(11, 14),
    D: full27.slice(14, 23),
    E_long: full27.slice(23, 27),
  };
}

export function compose27({ A, B, item, D, E_long }) {
  requireDigitString(A, 'A', 4);
  requireDigitString(B, 'B', 7);
  requireDigitString(item, 'item', 3);
  requireDigitString(D, 'D', 9);
  requireDigitString(E_long, 'E_long', 4);
  return A + B + item + D + E_long;
}

/** E_SHORT = (E_LONG mod 997) + 3, always 3 digits (range 003..999). */
export function eShort(eLong) {
  requireDigitString(eLong, 'E_long', 4);
  return ((BigInt(eLong) % 997n) + 3n).toString().padStart(3, '0');
}

/** All E_long values that map to a given E_short (10 or 11 of them; none for 000-002). */
export function eShortPreimages(eShortValue) {
  requireDigitString(eShortValue, 'E_short', 3);
  const out = [];
  for (let v = BigInt(eShortValue) - 3n; v >= 0n && v <= 9999n; v += 997n) out.push(v.toString().padStart(4, '0'));
  return out;
}

/** C: integer 0..9, one-digit string, or null/''/undefined (= missing). Never coerces '' to 0. */
export function parseC(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 9) return value;
    fail('E_BAD_C', 'C must be an integer 0..9', { value });
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '') return null;
    if (/^[0-9]$/.test(t)) return t.charCodeAt(0) - 48;
    fail('E_BAD_C', 'C must be a single digit 0..9', { value });
  }
  fail('E_BAD_C', `C must be 0..9, a one-digit string or null (got ${typeof value})`);
}

function requireC(value) {
  const c = parseC(value);
  if (c === null) fail('E_C_REQUIRED', 'C is required for this calculation but is missing');
  return c;
}

// ───────────────────────────── numeric compaction ──────────────────────────────

const B900 = 900n;

/** One numeric group (<= 44 digits): "1"+digits as BigInt, repeated divmod 900. */
export function numericGroupToCodewords(digits) {
  requireDigitString(digits, 'numeric group digits');
  if (digits.length > 44) fail('E_GROUP_TOO_LONG', 'A numeric-compaction group holds at most 44 digits');
  let value = BigInt('1' + digits);
  const out = [];
  while (value > 0n) {
    out.push(Number(value % B900)); // safe-number: remainder < 900
    value /= B900;
  }
  out.reverse();
  if (out.length !== Math.floor(digits.length / 3) + 1) fail('E_INTERNAL', 'codeword count rule violated');
  return out;
}

/** Full numeric compaction: splits into 44-digit groups as ISO/IEC 15438 requires. */
export function numericCompactionEncode(digits) {
  requireDigitString(digits, 'digits');
  const groups = [];
  const codewords = [];
  for (let i = 0; i < digits.length; i += 44) {
    const g = digits.slice(i, i + 44);
    const cws = numericGroupToCodewords(g);
    groups.push({ digits: g, withSentinel: '1' + g, codewords: cws });
    codewords.push(...cws);
  }
  return { codewords, groups };
}

/** One group of <= 15 codewords back to digits, with canonical-encoding checks. */
export function numericGroupToDigits(codewords) {
  const cws = requireIntArray(codewords, 'numeric codewords', 0, 899);
  if (cws.length < 1 || cws.length > 15) fail('E_GROUP_SIZE', 'A numeric group has 1..15 codewords', { length: cws.length });
  let value = 0n;
  for (const cw of cws) value = value * B900 + BigInt(cw);
  const withSentinel = value.toString();
  if (withSentinel[0] !== '1') {
    fail('E_NO_SENTINEL', 'Decoded value does not start with the numeric-compaction sentinel digit 1', { withSentinel, codewords: cws });
  }
  const payload = withSentinel.slice(1);
  const issues = [];
  if (cws[0] === 0) issues.push('LEADING_ZERO_CODEWORD');
  if (payload.length === 0) issues.push('EMPTY_PAYLOAD');
  let canonical = issues.length === 0;
  if (canonical) {
    const again = numericGroupToCodewords(payload);
    canonical = again.length === cws.length && again.every((v, i) => v === cws[i]);
    if (!canonical) issues.push('NOT_CANONICAL');
  }
  return { codewords: cws, withSentinel, payload, canonical, issues };
}

/** Decode a flat list of numeric codewords in groups of 15. */
export function numericCompactionDecode(codewords) {
  const cws = requireIntArray(codewords, 'numeric codewords', 0, 899);
  if (cws.length === 0) fail('E_EMPTY', 'No numeric codewords');
  const groups = [];
  for (let i = 0; i < cws.length; i += 15) groups.push(numericGroupToDigits(cws.slice(i, i + 15)));
  return { payload: groups.map((g) => g.payload).join(''), groups, canonical: groups.every((g) => g.canonical) };
}

/** Backwards-compatible names from the original module (now group-correct). */
export function decimalToBase900(digits) {
  return numericCompactionEncode(digits).codewords;
}
export function base900ToDecimal(codewords) {
  const r = numericCompactionDecode(codewords);
  return { withSentinel: r.groups.length === 1 ? r.groups[0].withSentinel : null, payload: r.payload, groups: r.groups, canonical: r.canonical };
}

/** SHOW WORK (decode direction): VALUE = sum N_i * 900^(k-i). All big values as strings. */
export function numericDecodeWork(codewords) {
  const cws = requireIntArray(codewords, 'numeric codewords', 0, 899);
  if (cws.length < 1 || cws.length > 15) fail('E_GROUP_SIZE', 'SHOW WORK covers one group of 1..15 codewords');
  const k = cws.length - 1;
  let total = 0n;
  const terms = cws.map((n, i) => {
    const power = k - i;
    const pow = B900 ** BigInt(power);
    const term = BigInt(n) * pow;
    total += term;
    return { index: i, codeword: n, power, powerValue: pow.toString(), term: term.toString() };
  });
  const decoded = numericGroupToDigits(cws);
  return { formula: 'VALUE = Σ N_i · 900^(k−i)', k, terms, value: total.toString(), ...decoded };
}

/** SHOW WORK (encode direction): long division of "1"+digits by 900. */
export function numericEncodeWork(digits) {
  requireDigitString(digits, 'digits');
  if (digits.length > 44) fail('E_GROUP_TOO_LONG', 'SHOW WORK covers one group of <= 44 digits');
  let value = BigInt('1' + digits);
  const steps = [];
  while (value > 0n) {
    const q = value / B900;
    const r = value % B900;
    steps.push({ dividend: value.toString(), quotient: q.toString(), remainder: Number(r) }); // safe-number: < 900
    value = q;
  }
  return { withSentinel: '1' + digits, steps, codewords: steps.map((s) => s.remainder).reverse() };
}

/** [SLD, 902, N...] for an all-numeric payload (no padding). */
export function buildNumericDataCodewords(payloadDigits) {
  const { codewords } = numericCompactionEncode(payloadDigits);
  return [codewords.length + 2, 902, ...codewords];
}

/** Pad data codewords with 900s to fill rows*cols and rewrite the SLD. */
export function padToSymbol(dataCodewords, { rows, cols, ecLevel }) {
  validateSymbolGeometry({ rows, cols, ecLevel });
  const data = requireIntArray(dataCodewords, 'data codewords', 0, 928);
  const capacity = rows * cols - ecCountForLevel(ecLevel);
  if (data.length > capacity) fail('E_CAPACITY', `Data needs ${data.length} codewords, symbol holds ${capacity}`);
  const out = data.slice();
  while (out.length < capacity) out.push(900);
  out[0] = capacity;
  return out;
}

/**
 * The last codeword of a single numeric group has a closed form, because
 * 10^j ≡ 100 (mod 900) for j >= 2:
 *   N_last = 10·d[n-2] + d[n-1] + 100 · ((1 + Σ d[0..n-3]) mod 9)
 * i.e. its last two decimal digits ARE the payload's last two digits.
 */
export function lastCodewordDecomposition(payloadDigits) {
  requireDigitString(payloadDigits, 'payload');
  if (payloadDigits.length < 2 || payloadDigits.length > 44) fail('E_LENGTH', 'payload must be 2..44 digits');
  const d = [...payloadDigits].map((ch) => ch.charCodeAt(0) - 48);
  const lastTwo = 10 * d[d.length - 2] + d[d.length - 1];
  const digitSumWithSentinel = 1 + d.slice(0, -2).reduce((a, b) => a + b, 0);
  const checksum = digitSumWithSentinel % 9;
  return { lastTwoDigits: lastTwo, digitSumWithSentinel, checksumMod9: checksum, value: lastTwo + 100 * checksum };
}

// ──────────────────────────── Reed-Solomon GF(929) ─────────────────────────────

const P = 929;
const modP = (x) => ((x % P) + P) % P;

export function ecCountForLevel(level) {
  requireInt(level, 'ecLevel', 0, 8);
  return 2 ** (level + 1);
}

export function ecLevelForCount(count) {
  for (let L = 0; L <= 8; L++) if (2 ** (L + 1) === count) return L;
  return null;
}

const generatorCache = new Map();
/** g(x) = Π_{i=1..k} (x − 3^i) mod 929, highest degree first, leading 1 included. */
export function rsGeneratorPolynomial(level) {
  const k = ecCountForLevel(level);
  if (generatorCache.has(level)) return generatorCache.get(level).slice();
  let poly = [1];
  let root = 1;
  for (let i = 1; i <= k; i++) {
    root = (root * 3) % P;
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = modP(next[j] + poly[j]);
      next[j + 1] = modP(next[j + 1] - poly[j] * root);
    }
    poly = next;
  }
  generatorCache.set(level, poly);
  return poly.slice();
}

/** ISO/IEC 15438 coefficient-table form: a_0..a_{k-1}, lowest degree first. */
export function rsIsoCoefficients(level) {
  return rsGeneratorPolynomial(level).slice(1).reverse();
}

/** EC codewords = −(data(x)·x^k mod g(x)), highest degree first. */
export function computeErrorCorrection(dataCodewords, level) {
  const data = requireIntArray(dataCodewords, 'data codewords', 0, 928);
  const g = rsGeneratorPolynomial(level);
  const k = g.length - 1;
  const r = new Array(k).fill(0);
  for (const d of data) {
    const feedback = modP(d + r[0]);
    for (let m = 1; m < k; m++) r[m - 1] = modP(r[m] - feedback * g[m]);
    r[k - 1] = modP(-feedback * g[k]);
  }
  return r.map((x) => modP(-x));
}

/** S_i = c(3^i), i = 1..k. All zero ⇔ the codeword sequence is consistent. */
export function rsSyndromes(allCodewords, level) {
  const cws = requireIntArray(allCodewords, 'codewords', 0, 928);
  const k = ecCountForLevel(level);
  const out = [];
  let x = 1;
  for (let i = 1; i <= k; i++) {
    x = (x * 3) % P;
    let acc = 0;
    for (const c of cws) acc = (acc * x + c) % P;
    out.push(acc);
  }
  return out;
}

export function verifyErrorCorrection(allCodewords, level) {
  const syndromes = rsSyndromes(allCodewords, level);
  return { syndromes, valid: syndromes.every((s) => s === 0) };
}

const POW3 = new Int32Array(928);
const LOG3 = new Int32Array(929).fill(-1);
(() => { let v = 1; for (let i = 0; i < 928; i++) { POW3[i] = v; LOG3[v] = i; v = (v * 3) % P; } })();
const invP = (a) => POW3[(928 - LOG3[a]) % 928];

/**
 * Locate and correct a SINGLE wrong codeword from the syndromes (S_i = e·β^i).
 * Returns null when the syndromes are zero or are not explained by one error.
 */
export function rsLocateSingleError(allCodewords, level) {
  const cws = requireIntArray(allCodewords, 'codewords', 0, 928);
  const S = rsSyndromes(cws, level);
  if (S.every((s) => s === 0)) return null;
  if (S[0] === 0 || S[1] === 0) return null;
  const beta = (S[1] * invP(S[0])) % P;
  const e = (S[0] * invP(beta)) % P;
  let bi = 1;
  for (let i = 0; i < S.length; i++) {
    bi = (bi * beta) % P;
    if ((e * bi) % P !== S[i]) return null;
  }
  const degree = LOG3[beta];
  const position = cws.length - 1 - degree;
  if (position < 0 || position >= cws.length) return null;
  const corrected = modP(cws[position] - e);
  return { position, observedValue: cws[position], errorMagnitude: e, correctedValue: corrected };
}

// ─────────────────────────── geometry & row indicators ─────────────────────────

export function validateSymbolGeometry({ rows, cols, ecLevel }) {
  requireInt(rows, 'rows', 3, 90);
  requireInt(cols, 'cols', 1, 30);
  requireInt(ecLevel, 'ecLevel', 0, 8);
  if (rows * cols > 928) fail('E_GEOMETRY', 'rows × cols exceeds 928 codewords');
  if (ecCountForLevel(ecLevel) >= rows * cols) fail('E_GEOMETRY', 'EC codewords do not leave room for data');
  return true;
}

export function clusterForRow(rowIndex) {
  requireInt(rowIndex, 'rowIndex', 0, 89);
  return (rowIndex % 3) * 3;
}

export function clusterAlias(cluster) {
  if (cluster !== 0 && cluster !== 3 && cluster !== 6) fail('E_BAD_CLUSTER', 'cluster must be 0, 3 or 6', { cluster });
  return cluster / 3;
}

/** Left/right row indicator values (ISO/IEC 15438; identical to ZXing's encoder). */
export function rowIndicatorValues({ rowIndex, rows, cols, ecLevel }) {
  validateSymbolGeometry({ rows, cols, ecLevel });
  requireInt(rowIndex, 'rowIndex', 0, rows - 1);
  const base = 30 * Math.floor(rowIndex / 3);
  const rowsInfo = Math.floor((rows - 1) / 3);
  const ecInfo = ecLevel * 3 + ((rows - 1) % 3);
  const colsInfo = cols - 1;
  switch (rowIndex % 3) {
    case 0: return { cluster: 0, left: base + rowsInfo, right: base + colsInfo };
    case 1: return { cluster: 3, left: base + ecInfo, right: base + rowsInfo };
    default: return { cluster: 6, left: base + colsInfo, right: base + ecInfo };
  }
}

const INDICATOR_KIND = { left: ['rows', 'ec', 'cols'], right: ['cols', 'rows', 'ec'] };

export function decodeRowIndicator({ value, rowIndex, side }) {
  requireInt(value, 'value', 0, 928);
  requireInt(rowIndex, 'rowIndex', 0, 89);
  if (side !== 'left' && side !== 'right') fail('E_BAD_SIDE', "side must be 'left' or 'right'");
  const rowGroup = Math.floor(value / 30);
  const info = value % 30;
  const kind = INDICATOR_KIND[side][rowIndex % 3];
  const out = { value, rowIndex, side, cluster: (rowIndex % 3) * 3, rowGroup,
    rowGroupMatches: rowGroup === Math.floor(rowIndex / 3), kind, info, valid: true };
  if (kind === 'rows') out.rowsDiv3 = info;
  if (kind === 'cols') out.cols = info + 1;
  if (kind === 'ec') {
    if (info > 26) out.valid = false;
    out.ecLevel = Math.floor(info / 3);
    out.rowsMod3 = info % 3;
  }
  if (!out.rowGroupMatches) out.valid = false;
  return out;
}

/** Majority-vote rows/cols/ecLevel from any number of decoded row indicators. */
export function inferSymbolGeometry(indicators) {
  const votes = { rowsDiv3: new Map(), rowsMod3: new Map(), ecLevel: new Map(), cols: new Map() };
  const invalid = [];
  for (const ind of indicators) {
    const d = decodeRowIndicator(ind);
    if (!d.valid) { invalid.push(d); continue; }
    for (const key of Object.keys(votes)) {
      if (d[key] !== undefined) votes[key].set(d[key], (votes[key].get(d[key]) || 0) + 1);
    }
  }
  const pick = (m) => {
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (entries.length === 0) return { value: null, conflict: false };
    const tie = entries.length > 1 && entries[0][1] === entries[1][1];
    return { value: tie ? null : entries[0][0], conflict: entries.length > 1 };
  };
  const r = Object.fromEntries(Object.entries(votes).map(([k, m]) => [k, pick(m)]));
  const rows = r.rowsDiv3.value !== null && r.rowsMod3.value !== null ? r.rowsDiv3.value * 3 + r.rowsMod3.value + 1 : null;
  const conflicts = Object.entries(r).filter(([, v]) => v.conflict).map(([k]) => k);
  return { rows, cols: r.cols.value, ecLevel: r.ecLevel.value, conflicts, invalid,
    votes: Object.fromEntries(Object.entries(votes).map(([k, m]) => [k, Object.fromEntries(m)])) };
}

/** Rows of the symbol with clusters and row indicators (Barcode Row View). */
export function buildPhysicalLayout({ codewords, rows, cols, ecLevel }) {
  validateSymbolGeometry({ rows, cols, ecLevel });
  const cws = requireIntArray(codewords, 'codewords', 0, 928);
  if (cws.length !== rows * cols) fail('E_LAYOUT', `Expected ${rows * cols} codewords, got ${cws.length}`);
  const out = [];
  for (let r = 0; r < rows; r++) {
    const { cluster, left, right } = rowIndicatorValues({ rowIndex: r, rows, cols, ecLevel });
    out.push({ rowIndex: r, cluster, clusterAlias: cluster / 3, left, codewords: cws.slice(r * cols, (r + 1) * cols), right });
  }
  return out;
}

// ───────────────────────────── data-stream parsing ─────────────────────────────

const LATCH_ROLE = {
  900: 'LATCH_TEXT', 901: 'LATCH_BYTE', 902: 'LATCH_NUMERIC', 924: 'LATCH_BYTE_6', 913: 'SHIFT_BYTE',
  922: 'MACRO_TERMINATOR', 923: 'MACRO_OPTIONAL_FIELD', 925: 'ECI_USER_DEFINED', 926: 'ECI_GENERAL_PURPOSE',
  927: 'ECI_CHARACTER_SET', 928: 'MACRO_CONTROL_BLOCK',
};
const ECI_PARAMS = { 925: 1, 926: 2, 927: 1 };

/**
 * Parse all codewords in data order (SLD, data, pads, EC). Labels every codeword
 * with a role and fully decodes numeric compaction. Text/byte segments are
 * labelled but not decoded here (payload is null in that case — never guessed).
 */
export function parseDataCodewords(allCodewords, options = {}) {
  const cws = requireIntArray(allCodewords, 'codewords', 0, 928);
  if (cws.length < 2) fail('E_TOO_SHORT', 'Need at least an SLD and one more codeword');
  const sld = cws[0];
  if (sld < 1 || sld > cws.length) fail('E_BAD_SLD', `Symbol length descriptor ${sld} is outside 1..${cws.length}`);
  const warnings = [];
  const ecCount = cws.length - sld;
  let ecLevel = options.ecLevel ?? null;
  if (ecLevel !== null) {
    if (ecCountForLevel(ecLevel) !== ecCount) warnings.push({ code: 'EC_COUNT_MISMATCH', expected: ecCountForLevel(ecLevel), found: ecCount });
  } else {
    ecLevel = ecLevelForCount(ecCount);
    if (ecLevel === null) warnings.push({ code: 'EC_LEVEL_UNKNOWN', ecCount });
  }
  const entries = cws.map((value, index) => ({ index, value, role: null, group: null }));
  entries[0].role = 'SLD'; entries[0].group = 'SLD';
  for (let i = sld; i < cws.length; i++) Object.assign(entries[i], { role: 'EC', group: 'EC', ecIndex: i - sld });
  let lastData = sld - 1;
  while (lastData >= 1 && cws[lastData] === 900) lastData--;
  for (let i = lastData + 1; i < sld; i++) Object.assign(entries[i], { role: 'PAD', group: 'PAD' });

  const numericGroups = [];
  let group = null;
  const closeGroup = () => {
    if (group) {
      try {
        Object.assign(group, numericGroupToDigits(group.codewords));
      } catch (err) {
        group.error = err.code || String(err);
        group.payload = null;
        warnings.push({ code: 'NUMERIC_GROUP_UNDECODABLE', start: group.start, reason: group.error });
      }
      numericGroups.push(group);
    }
    group = null;
  };
  let mode = 'TEXT';
  let sawNonNumericData = false;
  for (let i = 1; i <= lastData; i++) {
    const v = cws[i];
    const e = entries[i];
    if (v >= 900) {
      closeGroup();
      e.role = LATCH_ROLE[v] || 'CONTROL_RESERVED';
      e.group = [900, 901, 902, 924, 913].includes(v) ? 'LATCH' : 'CONTROL';
      if (!LATCH_ROLE[v]) warnings.push({ code: 'RESERVED_CODEWORD', index: i, value: v });
      if (v === 900) mode = 'TEXT';
      else if (v === 901 || v === 924) mode = 'BYTE';
      else if (v === 902) mode = 'NUMERIC';
      else if (v === 913 && i + 1 <= lastData) { i++; Object.assign(entries[i], { role: 'BYTE_DATA', group: 'DATA' }); sawNonNumericData = true; }
      else if (ECI_PARAMS[v]) { for (let p = 0; p < ECI_PARAMS[v] && i + 1 <= lastData; p++) { i++; Object.assign(entries[i], { role: 'ECI_PARAMETER', group: 'CONTROL' }); } }
      else if (v === 928) { for (let j = i + 1; j <= lastData; j++) Object.assign(entries[j], { role: 'MACRO_DATA', group: 'CONTROL' }); i = lastData; }
      continue;
    }
    e.group = 'DATA';
    if (mode === 'NUMERIC') {
      if (!group || group.codewords.length === 15) { closeGroup(); group = { start: i, codewords: [] }; }
      e.role = 'NUMERIC_DATA';
      e.numericGroup = numericGroups.length;
      e.positionInGroup = group.codewords.length;
      group.codewords.push(v);
    } else {
      e.role = mode === 'BYTE' ? 'BYTE_DATA' : 'TEXT_DATA';
      sawNonNumericData = true;
    }
  }
  closeGroup();
  const numericCodewords = numericGroups.flatMap((g) => g.codewords);
  let payload = null;
  let payloadNote = null;
  if (sawNonNumericData) payloadNote = 'Text/byte segments present: decode those with ZXing; pdf417Math decodes numeric compaction only.';
  else if (numericGroups.length === 0) payloadNote = 'No numeric-compaction data found.';
  else if (numericGroups.some((g) => g.payload === null)) payloadNote = 'A numeric group could not be decoded (see warnings).';
  else payload = numericGroups.map((g) => g.payload).join('');
  return { sld, ecLevel, ecCount, entries, numericGroups, numericCodewords, payload, payloadNote, warnings };
}

// ──────────────────────────── runs, modules, clusters ──────────────────────────

function requireCodewordRuns(runs, name = 'runs') {
  const r = requireIntArray(runs, name, 1, 6);
  if (r.length !== 8) fail('E_RUN_COUNT', `${name} must have exactly 8 runs`, { length: r.length });
  if (r.reduce((a, b) => a + b, 0) !== 17) fail('E_RUN_SUM', `${name} must sum to 17 modules`, { runs: r });
  return r;
}

export function runsToModules(runs, firstColor = 1) {
  const r = requireIntArray(runs, 'runs', 1, 64);
  if (firstColor !== 0 && firstColor !== 1) fail('E_BAD_COLOR', 'firstColor must be 0 or 1');
  const modules = [];
  let color = firstColor;
  for (const w of r) { for (let j = 0; j < w; j++) modules.push(color); color ^= 1; }
  return modules;
}

export function modulesToRuns(modules) {
  const m = requireIntArray(modules, 'modules', 0, 1);
  if (m.length === 0) fail('E_EMPTY', 'modules is empty');
  const runs = [];
  let len = 0;
  for (let i = 0; i < m.length; i++) {
    if (i > 0 && m[i] !== m[i - 1]) { runs.push(len); len = 0; }
    len++;
  }
  runs.push(len);
  return { firstColor: m[0], runs };
}

export function modulesToInteger(modules) {
  const m = requireIntArray(modules, 'modules', 0, 1);
  if (m.length < 1 || m.length > 52) fail('E_LENGTH', 'modules length must be 1..52');
  let v = 0;
  for (const b of m) v = v * 2 + b;
  return v;
}

export function integerToModules(value, width) {
  requireInt(width, 'width', 1, 52);
  requireInt(value, 'value', 0, 2 ** width - 1);
  const out = new Array(width);
  let v = value;
  for (let i = width - 1; i >= 0; i--) { out[i] = v % 2; v = Math.floor(v / 2); }
  return out;
}

/** Cluster number K = (b1 − b2 + b3 − b4 + 9) mod 9 over the 4 bar widths. */
export function clusterOfRuns(runs) {
  const r = requireCodewordRuns(runs);
  return (((r[0] - r[2] + r[4] - r[6]) % 9) + 9) % 9;
}

/** Edge-to-similar-edge distances t_i = r_i + r_{i+1}; immune to uniform ink spread. */
export function edgeDistances(runs) {
  const r = requireCodewordRuns(runs);
  return r.slice(0, 7).map((w, i) => w + r[i + 1]);
}

/** Everything the 17-MODULE VIEW needs for one 8-run pattern. */
export function describeCodewordRuns(runs) {
  const r = requireCodewordRuns(runs);
  const modules = runsToModules(r, 1);
  const cluster = clusterOfRuns(r);
  return { runs: r, modules, bitPattern: modules.join(''), patternInt: modulesToInteger(modules), cluster,
    validClusterFamily: cluster % 3 === 0, edges: edgeDistances(r) };
}

let CAND = null;
function candidates() {
  if (CAND) return CAND;
  const list = [];
  const walk = (prefix, remainingRuns, remainingTotal) => {
    if (remainingRuns === 0) { if (remainingTotal === 0) list.push(prefix); return; }
    for (let w = 1; w <= 6; w++) {
      const rest = remainingTotal - w;
      if (rest < remainingRuns - 1 || rest > (remainingRuns - 1) * 6) continue;
      walk([...prefix, w], remainingRuns - 1, rest);
    }
  };
  walk([], 8, 17);
  const n = list.length;
  const runs = new Uint8Array(n * 8);
  const cluster = new Uint8Array(n);
  const patternInt = new Uint32Array(n);
  const byClusterLists = Array.from({ length: 9 }, () => []);
  list.forEach((r, i) => {
    runs.set(r, i * 8);
    const k = (((r[0] - r[2] + r[4] - r[6]) % 9) + 9) % 9;
    cluster[i] = k;
    let v = 0;
    let color = 1;
    for (const w of r) { for (let j = 0; j < w; j++) v = v * 2 + color; color ^= 1; }
    patternInt[i] = v;
    byClusterLists[k].push(i);
  });
  const all = Uint32Array.from(list.keys());
  CAND = { count: n, runs, cluster, patternInt, all, byCluster: byClusterLists.map((l) => Uint32Array.from(l)) };
  return CAND;
}

/** All 10,480 compositions of 17 into 8 runs of 1..6 (fresh copies — safe to mutate). */
export function allCodewordRunCandidates() {
  const C = candidates();
  return Array.from({ length: C.count }, (_, i) => Array.from(C.runs.subarray(i * 8, i * 8 + 8)));
}

export function candidateCountsByCluster() {
  const C = candidates();
  return C.byCluster.map((l) => l.length);
}

/**
 * Least-squares ink-spread estimate against a KNOWN run pattern (start/stop):
 *   pixel_i = moduleWidth · modules_i + inkSpread · s_i,  s = +1 bar, −1 space.
 * Estimate once per row, then pass inkSpread to normalizeCodewordRuns.
 */
export function estimateInkSpread(pixelRuns, moduleRuns, firstColor = 1) {
  const p = requirePositiveFinite(pixelRuns, 'pixelRuns');
  const m = requireIntArray(moduleRuns, 'moduleRuns', 1, 64);
  if (p.length !== m.length || p.length < 2) fail('E_RUN_COUNT', 'pixelRuns and moduleRuns must have equal length >= 2');
  let Smm = 0, Sms = 0, Spm = 0, Sps = 0;
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const s = (i % 2 === 0) === (firstColor === 1) ? 1 : -1;
    Smm += m[i] * m[i]; Sms += m[i] * s; Spm += p[i] * m[i]; Sps += p[i] * s;
  }
  const det = Smm * n - Sms * Sms;
  if (det === 0) fail('E_SINGULAR', 'Pattern cannot separate module width from ink spread');
  const moduleWidth = (Spm * n - Sps * Sms) / det;
  const inkSpread = (Smm * Sps - Sms * Spm) / det;
  let residual = 0;
  for (let i = 0; i < n; i++) {
    const s = (i % 2 === 0) === (firstColor === 1) ? 1 : -1;
    residual += (p[i] - moduleWidth * m[i] - inkSpread * s) ** 2;
  }
  return { moduleWidth, inkSpread, residual };
}

function requirePositiveFinite(arr, name) {
  if (!isArrayLike(arr)) fail('E_NOT_ARRAY', `${name} must be an array`);
  const out = Array.from(arr);
  out.forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail('E_BAD_PIXEL_RUN', `${name}[${i}] must be a finite number > 0`, { value: v });
  });
  return out;
}

/**
 * Constrained normalisation of 8 measured pixel runs to integer module widths.
 * Searches every valid composition (never rounds runs independently).
 *
 * options.cluster          restrict to one cluster number (0/3/6 from the row)
 * options.allowedPatterns  object with has(patternInt): restrict to real PDF417
 *                          patterns (e.g. table.allowedPatterns(cluster))
 * options.inkSpread        pixels: bars shrink by this, spaces grow by it
 * options.method           'runs' (spec metric) | 'edges' (ink-spread invariant)
 *
 * error = Σ (runs_i/17 − pixel_i/Σpixel)² (the spec's metric) is always reported.
 * confidence = fitScore × marginScore — a deterministic heuristic, not a probability.
 */
export function normalizeCodewordRuns(pixelRuns, options = {}) {
  const { cluster = null, allowedPatterns = null, inkSpread = 0, method = 'runs' } = options;
  const raw = requirePositiveFinite(pixelRuns, 'pixelRuns');
  if (raw.length !== 8) fail('E_RUN_COUNT', 'A PDF417 codeword has exactly 8 runs', { length: raw.length });
  if (cluster !== null) requireInt(cluster, 'cluster', 0, 8);
  if (method !== 'runs' && method !== 'edges') fail('E_BAD_METHOD', "method must be 'runs' or 'edges'");
  if (typeof inkSpread !== 'number' || !Number.isFinite(inkSpread)) fail('E_BAD_INK_SPREAD', 'inkSpread must be finite');
  const px = raw.map((v, i) => v + (i % 2 === 0 ? -inkSpread : inkSpread));
  if (px.some((v) => v <= 0)) fail('E_BAD_INK_SPREAD', 'inkSpread correction produced a non-positive run');
  const total = px.reduce((a, b) => a + b, 0);
  const obs = px.map((v) => v / total);
  const obsEdges = obs.slice(0, 7).map((v, i) => v + obs[i + 1]);

  const C = candidates();
  const indices = cluster === null ? C.all : C.byCluster[cluster];
  let best = null;
  let second = null;
  let considered = 0;
  const better = (a, b) => a.primary < b.primary || (a.primary === b.primary && a.secondary < b.secondary);
  for (let n = 0; n < indices.length; n++) {
    const idx = indices[n];
    if (allowedPatterns && !allowedPatterns.has(C.patternInt[idx])) continue;
    considered++;
    const o = idx * 8;
    let eRuns = 0;
    for (let i = 0; i < 8; i++) { const d = C.runs[o + i] / 17 - obs[i]; eRuns += d * d; }
    let eEdges = 0;
    for (let i = 0; i < 7; i++) { const d = (C.runs[o + i] + C.runs[o + i + 1]) / 17 - obsEdges[i]; eEdges += d * d; }
    const cand = method === 'runs' ? { idx, primary: eRuns, secondary: 0, eRuns, eEdges } : { idx, primary: eEdges, secondary: eRuns, eRuns, eEdges };
    if (!best || better(cand, best)) { second = best; best = cand; } else if (!second || better(cand, second)) { second = cand; }
  }
  if (!best) fail('E_NO_CANDIDATE', 'No candidate pattern satisfies the given restrictions');
  const runsOf = (c) => Array.from(C.runs.subarray(c.idx * 8, c.idx * 8 + 8));
  const runs = runsOf(best);
  const observedModules = obs.map((v) => v * 17);
  const deviationModules = observedModules.map((v, i) => v - runs[i]);
  const maxAbsDeviation = Math.max(...deviationModules.map(Math.abs));
  const fitScore = Math.max(0, 1 - (maxAbsDeviation / 0.5) ** 2);
  const marginScore = second ? (second.primary > 0 ? (second.primary - best.primary) / second.primary : 0) : 1;
  const modules = runsToModules(runs, 1);
  return {
    method, runs, modules, bitPattern: modules.join(''), patternInt: C.patternInt[best.idx], cluster: C.cluster[best.idx],
    error: best.eRuns, edgeError: best.eEdges,
    second: second ? { runs: runsOf(second), patternInt: C.patternInt[second.idx], cluster: C.cluster[second.idx], error: second.eRuns, edgeError: second.eEdges } : null,
    tie: !!second && second.primary === best.primary,
    observedModules, deviationModules, maxAbsDeviation, fitScore, marginScore,
    confidence: fitScore * marginScore, candidatesConsidered: considered,
  };
}

/** Majority vote over repeated reads of the same cell (e.g. several scanlines). */
export function majorityVote(values) {
  if (!isArrayLike(values)) fail('E_NOT_ARRAY', 'values must be an array');
  const counts = new Map();
  let total = 0;
  for (const v of values) { if (v === null || v === undefined) continue; total++; counts.set(v, (counts.get(v) || 0) + 1); }
  if (total === 0) return { value: null, votes: 0, total: 0, agreement: 0, tie: false };
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const tie = sorted.length > 1 && sorted[0][1] === sorted[1][1];
  return { value: tie ? null : sorted[0][0], votes: sorted[0][1], total, agreement: sorted[0][1] / total, tie };
}

// ───────────────────────── official pattern-table adapter ──────────────────────

/**
 * Validate and index a codeword table supplied by a standards-compatible
 * library. entries: iterable of { pattern: 17-bit int, value: 0..928 }.
 * The cluster is derived from the pattern itself. Throws on anything wrong.
 */
export function createPatternTable(entries, { source = 'unspecified' } = {}) {
  const list = Array.from(entries);
  if (list.length !== 2787) fail('E_TABLE_SIZE', `A PDF417 table has 2787 entries (3 clusters × 929); got ${list.length}`);
  const byPattern = new Map();
  const byCluster = { 0: new Array(929).fill(null), 3: new Array(929).fill(null), 6: new Array(929).fill(null) };
  list.forEach((e, i) => {
    requireInt(e.pattern, `entries[${i}].pattern`, 0x10000, 0x1ffff);
    requireInt(e.value, `entries[${i}].value`, 0, 928);
    const { firstColor, runs } = modulesToRuns(integerToModules(e.pattern, 17));
    if (firstColor !== 1 || runs.length !== 8 || runs.some((r) => r > 6)) fail('E_TABLE_PATTERN', `entries[${i}] is not a valid 8-run codeword pattern`, e);
    const cluster = clusterOfRuns(runs);
    if (cluster % 3 !== 0) fail('E_TABLE_CLUSTER', `entries[${i}] has cluster ${cluster}`, e);
    if (byPattern.has(e.pattern)) fail('E_TABLE_DUPLICATE_PATTERN', `pattern ${e.pattern} appears twice`);
    if (byCluster[cluster][e.value] !== null) fail('E_TABLE_DUPLICATE_VALUE', `value ${e.value} appears twice in cluster ${cluster}`);
    byPattern.set(e.pattern, Object.freeze({ value: e.value, cluster }));
    byCluster[cluster][e.value] = e.pattern;
  });
  for (const c of [0, 3, 6]) if (byCluster[c].includes(null)) fail('E_TABLE_INCOMPLETE', `cluster ${c} is missing values`);
  const allowed = {};
  const edgeSignatureCollisions = {};
  for (const c of [0, 3, 6]) {
    const set = new Set(byCluster[c]);
    allowed[c] = Object.freeze({ has: (p) => set.has(p), size: set.size });
    const sigs = new Set(byCluster[c].map((p) => edgeDistances(modulesToRuns(integerToModules(p, 17)).runs).join(',')));
    edgeSignatureCollisions[c] = 929 - sigs.size;
  }
  return Object.freeze({
    source,
    size: 2787,
    lookup: (patternInt) => byPattern.get(patternInt) || null,
    patternFor: (value, cluster) => {
      requireInt(value, 'value', 0, 928);
      clusterAlias(cluster);
      return byCluster[cluster][value];
    },
    allowedPatterns: (cluster) => { clusterAlias(cluster); return allowed[cluster]; },
    stats: Object.freeze({ edgeSignatureCollisions: Object.freeze(edgeSignatureCollisions) }),
  });
}

/** ZXing decoder tables: PDF417Common.SYMBOL_TABLE + CODEWORD_TABLE (value = (cw − 1) mod 929). */
export function patternTableFromZxing(symbolTable, codewordTable, source = 'ZXing PDF417Common') {
  if (!isArrayLike(symbolTable) || !isArrayLike(codewordTable) || symbolTable.length !== codewordTable.length) {
    fail('E_TABLE_SIZE', 'SYMBOL_TABLE and CODEWORD_TABLE must be arrays of equal length');
  }
  const entries = Array.from(symbolTable, (pattern, i) => ({ pattern, value: (codewordTable[i] - 1) % 929 }));
  return createPatternTable(entries, { source });
}

/** ZXing encoder table: CODEWORD_TABLE[clusterAlias][value] = pattern. */
export function patternTableFromEncoderTable(table, source = 'ZXing PDF417 encoder') {
  if (!isArrayLike(table) || table.length !== 3) fail('E_TABLE_SIZE', 'Encoder table must be 3 × 929');
  const entries = [];
  table.forEach((row, alias) => {
    if (!isArrayLike(row) || row.length !== 929) fail('E_TABLE_SIZE', 'Encoder table must be 3 × 929');
    Array.from(row).forEach((pattern, value) => {
      const { runs } = modulesToRuns(integerToModules(pattern, 17));
      if (runs.length === 8 && clusterOfRuns(runs) !== alias * 3) fail('E_TABLE_CLUSTER', `table[${alias}][${value}] is not cluster ${alias * 3}`);
      entries.push({ pattern, value });
    });
  });
  return createPatternTable(entries, { source });
}

/**
 * Parse ZXing's PDF417Common.java source text (e.g. fetched in the browser from a
 * pinned jsDelivr URL) and build the validated table. Throws if anything is off.
 */
export function patternTableFromZxingJavaSource(javaText, source = 'ZXing PDF417Common.java') {
  if (typeof javaText !== 'string') fail('E_NOT_STRING', 'javaText must be the Java source as text');
  const extract = (name) => {
    const m = javaText.match(new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    if (!m) fail('E_TABLE_SOURCE', `${name} not found in the Java source`);
    return m[1].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((t) => t.trim()).filter(Boolean)
      .map((t) => {
        if (!/^(0x[0-9a-fA-F]{1,6}|[0-9]{1,6})$/.test(t)) fail('E_TABLE_SOURCE', `unexpected token ${t} in ${name}`);
        return Number(t); // safe-number: validated hex/decimal token of at most 6 digits
      });
  };
  return patternTableFromZxing(extract('SYMBOL_TABLE'), extract('CODEWORD_TABLE'), source);
}

/** Build the table by asking a library lookup function (pattern → value or −1/null) about every candidate. */
export function patternTableFromLookup(lookupFn, source = 'library lookup function') {
  if (typeof lookupFn !== 'function') fail('E_NOT_FUNCTION', 'lookupFn must be a function');
  const C = candidates();
  const entries = [];
  for (let i = 0; i < C.count; i++) {
    const value = lookupFn(C.patternInt[i]);
    if (value !== -1 && value !== null && value !== undefined) entries.push({ pattern: C.patternInt[i], value });
  }
  return createPatternTable(entries, { source });
}

/** Glossary entry for a codeword value in a cluster (pattern details need a table). */
export function glossaryEntry(value, cluster, table = null) {
  requireInt(value, 'value', 0, 928);
  const alias = clusterAlias(cluster);
  const entry = { value, cluster, clusterAlias: alias, control: CONTROL_CODEWORDS[value] || null };
  if (table) {
    const pattern = table.patternFor(value, cluster);
    const info = describeCodewordRuns(modulesToRuns(integerToModules(pattern, 17)).runs);
    Object.assign(entry, { patternInt: pattern, bitPattern: info.bitPattern, runs: info.runs, source: table.source });
  } else {
    entry.patternInt = null;
    entry.note = 'Pattern unavailable: load the official table with patternTableFrom*()';
  }
  return entry;
}

// ─────────────────────────────── selectors ─────────────────────────────────────

function requireTenNumeric(N) {
  const n = requireIntArray(N, 'N', 0, 899);
  if (n.length !== 10) fail('E_NEED_TEN', 'Selector analysis requires exactly 10 numeric codewords N0..N9', { length: n.length });
  return n;
}

export function cSelector(c, N) {
  const index = requireC(c);
  const n = requireTenNumeric(N);
  return { index, value: n[index] };
}

/** digit d → N[d] for every digit of a decimal string (D or E_long). */
export function selectorPath(digits, N) {
  requireDigitString(digits, 'selector digits');
  const n = requireTenNumeric(N);
  return [...digits].map((ch, position) => {
    const d = ch.charCodeAt(0) - 48;
    return { position, digit: d, codewordIndex: d, value: n[d] };
  });
}

// ───────────────────────────── study records ───────────────────────────────────

/** StudyRecord entity. EC is computed for the [SLD, 902, N] stream at ecLevel and labelled as computed. */
export function buildStudyRecord(full27, { c = null, ecLevel = 2 } = {}) {
  const f = parse27(full27);
  const C = parseC(c);
  const dataCodewords = buildNumericDataCodewords(full27);
  const N = dataCodewords.slice(2);
  const rec = {
    ...f, C, E_short: eShort(f.E_long), N, dataCodewords,
    ecLevel, errorCorrection: ecLevel === null ? null : computeErrorCorrection(dataCodewords, ecLevel),
    errorCorrectionSource: ecLevel === null ? null : 'computed',
  };
  if (N.length === 10) {
    rec.dPath = selectorPath(f.D, N).map((s) => s.value);
    rec.ePath = selectorPath(f.E_long, N).map((s) => s.value);
    rec.cSelectorValue = C === null ? null : N[C];
  }
  return rec;
}

/** Downstream decode from codewords (after image decode or manual edits). */
export function analyzeCodewords({ codewords, rows = null, cols = null, ecLevel = null, c = null }) {
  const cws = requireIntArray(codewords, 'codewords', 0, 928);
  const parsed = parseDataCodewords(cws, { ecLevel: ecLevel ?? undefined });
  const level = parsed.ecLevel;
  const ec = level === null ? null : verifyErrorCorrection(cws, level);
  const singleError = ec && !ec.valid ? rsLocateSingleError(cws, level) : null;
  const layout = rows !== null && cols !== null && level !== null ? buildPhysicalLayout({ codewords: cws, rows, cols, ecLevel: level }) : null;
  let study = null;
  if (parsed.payload !== null && parsed.payload.length === 27) {
    study = buildStudyRecord(parsed.payload, { c, ecLevel: level });
    study.errorCorrection = cws.slice(parsed.sld);
    study.errorCorrectionSource = 'observed';
  }
  return { parsed, errorCorrection: ec, singleError, layout, study };
}

// ─────────────────────────── integer / digit operators ─────────────────────────

export function toBigIntStrict(value, name = 'value') {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('E_UNSAFE_NUMBER', `${name} is not a safe integer; pass a decimal string or BigInt`, { value });
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value);
  fail('E_NOT_INTEGER', `${name} must be an integer (BigInt, safe Number or decimal string)`, { value: String(value) });
}

export function modBig(value, modulus) {
  const m = toBigIntStrict(modulus, 'modulus');
  if (m <= 0n) fail('E_BAD_MODULUS', 'modulus must be > 0');
  const n = toBigIntStrict(value);
  return ((n % m) + m) % m;
}

/** Non-negative modulo. Returns a Number; modulus must be a safe integer. */
export function modulo(value, modulus) {
  if (typeof modulus === 'number' && !Number.isSafeInteger(modulus)) fail('E_UNSAFE_NUMBER', 'modulus must be a safe integer');
  const r = modBig(value, modulus);
  if (r > BigInt(Number.MAX_SAFE_INTEGER)) fail('E_UNSAFE_NUMBER', 'result too large; use modBig');
  return Number(r); // safe-number: bounded by MAX_SAFE_INTEGER check above
}

export function digitSum(value) {
  let s;
  if (typeof value === 'string') s = value.startsWith('-') ? value.slice(1) : value;
  else s = toBigIntStrict(value).toString().replace('-', '');
  requireDigitString(s, 'digitSum input');
  let sum = 0;
  for (const ch of s) sum += ch.charCodeAt(0) - 48;
  return sum;
}

export function hammingDistance(a, b) {
  const isSeq = (x) => typeof x === 'string' || isArrayLike(x);
  if (!isSeq(a) || !isSeq(b)) fail('E_NOT_SEQUENCE', 'hammingDistance compares strings or arrays (never Numbers)');
  if (a.length !== b.length) fail('E_LENGTH', 'Values must have equal length');
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
  return changed;
}

export function changedPositions(a, b) {
  hammingDistance(a, b);
  const out = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

// ─────────────────────── codeword sensitivity (self-correlation) ───────────────

/**
 * For each numeric codeword position k and payload digit position j: how many of
 * the 9 alternative digits at j change N_k. Shows which fields each codeword
 * actually depends on (e.g. N_last depends on every digit via a mod-9 checksum).
 */
export function codewordSensitivity(payload) {
  requireDigitString(payload, 'payload');
  if (payload.length > 44) fail('E_LENGTH', 'sensitivity is defined for one numeric group (<= 44 digits)');
  const base = numericGroupToCodewords(payload);
  const matrix = base.map(() => new Array(payload.length).fill(0));
  for (let j = 0; j < payload.length; j++) {
    for (let d = 0; d <= 9; d++) {
      if (d === payload.charCodeAt(j) - 48) continue;
      const alt = numericGroupToCodewords(payload.slice(0, j) + d + payload.slice(j + 1));
      for (let k = 0; k < base.length; k++) if (alt[k] !== base[k]) matrix[k][j]++;
    }
  }
  return { codewords: base, matrix };
}

// ───────────────────────────── deterministic RNG ───────────────────────────────

const MASK64 = (1n << 64n) - 1n;
const PCG_MULT = 6364136223846793005n;

/** PCG32 (XSH-RR). new Pcg32(42, 54) reproduces the published pcg32 reference stream. */
export class Pcg32 {
  constructor(seed = 1, stream = 54) {
    this.state = 0n;
    this.inc = ((toBigIntStrict(stream, 'stream') << 1n) | 1n) & MASK64;
    this.nextUint32();
    this.state = (this.state + (toBigIntStrict(seed, 'seed') & MASK64)) & MASK64;
    this.nextUint32();
  }
  nextUint32() {
    const old = this.state;
    this.state = (old * PCG_MULT + this.inc) & MASK64;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn); // safe-number: 32-bit value
    const rot = Number(old >> 59n); // safe-number: 0..31
    return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
  }
  /** Uniform integer in [0, n) by rejection sampling (no modulo bias). */
  below(n) {
    requireInt(n, 'n', 1, 2 ** 32);
    const limit = 2 ** 32 - (2 ** 32 % n);
    for (;;) { const r = this.nextUint32(); if (r < limit) return r % n; }
  }
  digits(length) {
    requireInt(length, 'length', 1, 10000);
    let s = '';
    while (s.length < length) {
      const chunk = Math.min(9, length - s.length);
      s += String(this.below(10 ** chunk)).padStart(chunk, '0');
    }
    return s;
  }
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) { const j = this.below(i + 1); [array[i], array[j]] = [array[j], array[i]]; }
    return array;
  }
}

export function rejectionLimit(n) {
  requireInt(n, 'n', 1, 2 ** 32);
  return 2 ** 32 - (2 ** 32 % n);
}

// ─────────────────────────────── statistics ────────────────────────────────────

function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; }

/** Exact fraction → { numerator, denominator } strings plus a display Number. */
export function fraction(num, den) {
  const n = toBigIntStrict(num, 'numerator');
  const d = toBigIntStrict(den, 'denominator');
  if (d <= 0n) fail('E_BAD_DENOMINATOR', 'denominator must be > 0');
  const g = gcd(n, d) || 1n;
  const rn = n / g, rd = d / g;
  return { numerator: rn.toString(), denominator: rd.toString(), value: fractionToNumber(rn, rd) };
}

function fractionToNumber(n, d) {
  if (n === 0n) return 0;
  const neg = n < 0n;
  if (neg) n = -n;
  const shift = BigInt(Math.max(0, d.toString().length - n.toString().length + 20));
  const scaled = (n * 10n ** shift) / d;
  const v = Number(scaled) / 10 ** Number(shift); // safe-number: display approximation of an exact fraction
  return neg ? -v : v;
}

function parseProbability(p) {
  if (typeof p === 'string' && /^\d+\/\d+$/.test(p)) {
    const [a, b] = p.split('/').map((x) => BigInt(x));
    if (b === 0n || a > b) fail('E_BAD_PROBABILITY', 'p must be in [0,1]');
    return [a, b];
  }
  if (p && typeof p === 'object' && 'num' in p && 'den' in p) return parseProbability(`${p.num}/${p.den}`);
  fail('E_BAD_PROBABILITY', "p must be an exact fraction like '9/10' or {num, den}");
}

/**
 * Exact binomial test with rational p (e.g. '9/10'). Streams the pmf with
 * BigInt so memory is O(n). Two-sided uses the "sum of outcomes no more likely
 * than observed" rule (as R's binom.test), compared exactly.
 */
export function binomialTestExact(k, n, p) {
  requireInt(n, 'n', 0, 50000);
  requireInt(k, 'k', 0, n);
  const [a, den] = parseProbability(p);
  const b = den - a;
  const Nb = BigInt(n);
  const denom = den ** Nb;
  const pmfAt = (i) => {
    let c = 1n;
    for (let j = 0; j < i; j++) c = (c * (Nb - BigInt(j))) / BigInt(j + 1);
    return c * a ** BigInt(i) * b ** (Nb - BigInt(i));
  };
  const target = pmfAt(k);
  let lower = 0n, upper = 0n, two = 0n;
  let cur = b ** Nb;
  for (let i = 0; i <= n; i++) {
    if (i > 0) {
      if (b === 0n) cur = i === n ? a ** Nb : 0n;
      else cur = (cur * BigInt(n - i + 1) * a) / (BigInt(i) * b);
    }
    if (i <= k) lower += cur;
    if (i >= k) upper += cur;
    if (cur <= target) two += cur;
  }
  return {
    k, n, p: `${a}/${den}`,
    expected: fraction(Nb * a, den),
    pmf: fraction(target, denom),
    lower: fraction(lower, denom),
    upper: fraction(upper, denom),
    twoSided: fraction(two, denom),
  };
}

export function mean(values) {
  if (!isArrayLike(values) || values.length === 0) fail('E_EMPTY', 'mean of empty list');
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Sample standard deviation (n − 1). */
export function sampleStd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  let ss = 0;
  for (const v of values) ss += (v - m) ** 2;
  return Math.sqrt(ss / (values.length - 1));
}

export function zScore(observed, m, sd) {
  return sd > 0 ? (observed - m) / sd : null;
}

/** Empirical randomization p-value with the +1 correction: (1 + #extreme) / (1 + B). Never 0. */
export function empiricalPValue(observed, simulated, alternative = 'greater') {
  if (!isArrayLike(simulated)) fail('E_NOT_ARRAY', 'simulated must be an array');
  let extreme = 0;
  const m = alternative === 'two-sided' ? mean(simulated) : 0;
  for (const s of simulated) {
    if (alternative === 'greater' ? s >= observed : alternative === 'less' ? s <= observed : Math.abs(s - m) >= Math.abs(observed - m)) extreme++;
  }
  if (!['greater', 'less', 'two-sided'].includes(alternative)) fail('E_BAD_ALTERNATIVE', 'alternative must be greater|less|two-sided');
  return { extreme, iterations: simulated.length, ...fraction(1 + extreme, 1 + simulated.length) };
}

export function holmAdjust(pValues) {
  const m = pValues.length;
  const order = pValues.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = new Array(m);
  let running = 0;
  order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, p * (m - rank))); out[i] = running; });
  return out;
}

export function benjaminiHochberg(pValues) {
  const m = pValues.length;
  const order = pValues.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = new Array(m);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) { const [p, i] = order[r]; running = Math.min(running, (p * m) / (r + 1)); out[i] = Math.min(1, running); }
  return out;
}

export function multipleTestingNote(hypothesesTested, alpha = 0.05) {
  requireInt(hypothesesTested, 'hypothesesTested', 1, 1e9);
  return {
    hypothesesTested, alpha,
    bonferroniAlpha: alpha / hypothesesTested,
    expectedFalsePositivesUnderNull: alpha * hypothesesTested,
    warning: hypothesesTested > 1
      ? `${hypothesesTested} hypotheses tested: about ${alpha * hypothesesTested} would reach p < ${alpha} by chance alone. Use adjusted p-values and a held-out test set.`
      : null,
  };
}

// ───────────────────── hypothesis rules (JSON operation specs) ─────────────────

// Values: int → BigInt, digits → string, list → BigInt[], bool, null (= not applicable).
const FIELD_NAMES = new Set(['A', 'B', 'item', 'D', 'E_long', 'E_short', 'full27']);

function evalNode(node, ctx, depth) {
  if (depth > 64) fail('E_RULE_DEPTH', 'rule nested too deeply');
  if (node === null || typeof node !== 'object' || Array.isArray(node)) fail('E_RULE_SYNTAX', 'each rule node must be an object');
  if ('const' in node) return toBigIntStrict(node.const, 'const');
  if ('field' in node) {
    if (node.field === 'C') return ctx.record.C === null ? null : BigInt(ctx.record.C);
    if (!FIELD_NAMES.has(node.field)) fail('E_RULE_FIELD', `unknown field ${node.field}`);
    return ctx.record[node.field];
  }
  if ('list' in node) {
    if (node.list === 'N') return ctx.record.N.map((v) => BigInt(v));
    if (node.list === 'EC') return ctx.ec().map((v) => BigInt(v));
    fail('E_RULE_LIST', `unknown list ${node.list}`);
  }
  if (!('op' in node)) fail('E_RULE_SYNTAX', 'node needs const, field, list or op');
  const args = (node.args || []).map((a) => evalNode(a, ctx, depth + 1));
  if (args.some((a) => a === null) && node.op !== 'isNull') return null;
  const int = (v, i) => {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'string') return BigInt(v);
    fail('E_RULE_TYPE', `${node.op}: argument ${i} must be an integer`);
  };
  const list = (v, i) => { if (!Array.isArray(v)) fail('E_RULE_TYPE', `${node.op}: argument ${i} must be a list`); return v; };
  const digits = (v, i) => {
    if (typeof v === 'string') return v;
    if (typeof v === 'bigint' && v >= 0n) return v.toString();
    fail('E_RULE_TYPE', `${node.op}: argument ${i} must be digits`);
  };
  const index = (v, len) => { const i = int(v, 1); return i < 0n || i >= BigInt(len) ? null : Number(i); }; // safe-number: bounded by list length
  const floorDiv = (x, y) => { if (y === 0n) return null; const q = x / y; return (x % y !== 0n && (x < 0n) !== (y < 0n)) ? q - 1n : q; };
  const eq = (x, y) => (Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => v === y[i]) : x === y);
  switch (node.op) {
    case 'add': return int(args[0], 0) + int(args[1], 1);
    case 'sub': return int(args[0], 0) - int(args[1], 1);
    case 'mul': return int(args[0], 0) * int(args[1], 1);
    case 'idiv': return floorDiv(int(args[0], 0), int(args[1], 1));
    case 'mod': return modBig(int(args[0], 0), int(args[1], 1));
    case 'absdiff': { const d = int(args[0], 0) - int(args[1], 1); return d < 0n ? -d : d; }
    case 'bitxor': return int(args[0], 0) ^ int(args[1], 1);
    case 'bitand': return int(args[0], 0) & int(args[1], 1);
    case 'bitor': return int(args[0], 0) | int(args[1], 1);
    case 'min': case 'max': {
      const vals = args.length === 1 ? list(args[0], 0) : args.map(int);
      if (vals.length === 0) return null;
      return vals.reduce((m, v) => (node.op === 'min' ? (v < m ? v : m) : (v > m ? v : m)));
    }
    case 'sum': return list(args[0], 0).reduce((s, v) => s + v, 0n);
    case 'len': return BigInt(Array.isArray(args[0]) ? args[0].length : digits(args[0], 0).length);
    case 'digitSum': return BigInt(digitSum(digits(args[0], 0)));
    case 'digitAt': { const s = digits(args[0], 0); const i = index(args[1], s.length); return i === null ? null : BigInt(s.charCodeAt(i) - 48); }
    case 'digits': return [...digits(args[0], 0)].map((ch) => BigInt(ch.charCodeAt(0) - 48));
    case 'concat': return digits(args[0], 0) + digits(args[1], 1);
    case 'toInt': return BigInt(digits(args[0], 0));
    case 'at': { const l = list(args[0], 0); const i = index(args[1], l.length); return i === null ? null : l[i]; }
    case 'select': { const l = list(args[0], 0); return [...digits(args[1], 1)].map((ch) => { const i = ch.charCodeAt(0) - 48; return i < l.length ? l[i] : null; }); }
    case 'neighbor': {
      const l = list(args[0], 0);
      const i = int(args[1], 1) + int(args[2], 2);
      const mode = node.mode || 'none';
      if (mode === 'wrap') return l[Number(modBig(i, l.length))]; // safe-number: < list length
      return i < 0n || i >= BigInt(l.length) ? null : l[Number(i)]; // safe-number: bounded by list length
    }
    case 'rank': { const l = list(args[0], 0); const i = index(args[1], l.length); return i === null ? null : BigInt(l.filter((v) => v < l[i]).length); }
    case 'rotate': { const l = list(args[0], 0); const k = Number(modBig(int(args[1], 1), l.length || 1)); return l.slice(k).concat(l.slice(0, k)); } // safe-number: < list length
    case 'permute': {
      const l = list(args[0], 0); const perm = list(args[1], 1);
      const idx = perm.map((v) => Number(v)); // safe-number: validated below as 0..len-1
      if (idx.length !== l.length || new Set(idx).size !== l.length || idx.some((v) => v < 0 || v >= l.length)) fail('E_RULE_PERM', 'invalid permutation');
      return idx.map((i) => l[i]);
    }
    case 'eq': return eq(args[0], args[1]);
    case 'ne': return !eq(args[0], args[1]);
    case 'lt': return int(args[0], 0) < int(args[1], 1);
    case 'le': return int(args[0], 0) <= int(args[1], 1);
    case 'gt': return int(args[0], 0) > int(args[1], 1);
    case 'ge': return int(args[0], 0) >= int(args[1], 1);
    case 'in': return list(args[1], 1).includes(int(args[0], 0));
    case 'all': return args.every((v) => v === true);
    case 'any': return args.some((v) => v === true);
    case 'not': return args[0] !== true;
    default: fail('E_RULE_OP', `unknown op ${node.op}`);
  }
}

/** Evaluate a JSON rule spec against a StudyRecord. Returns BigInt/string/list/bool/null. */
export function evaluateRule(spec, record, { ecLevel = 2 } = {}) {
  let ecCache = null;
  const ctx = { record, ec: () => (ecCache ??= record.errorCorrection ?? computeErrorCorrection(record.dataCodewords, ecLevel)) };
  return evalNode(spec, ctx, 0);
}

/** JSON-safe version of a rule result (BigInt → decimal string). */
export function ruleResultToJSON(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(ruleResultToJSON);
  return v;
}

function fastRecord(full27, C) {
  const cws = numericGroupToCodewords(full27);
  return { full27, A: full27.slice(0, 4), B: full27.slice(4, 11), item: full27.slice(11, 14), D: full27.slice(14, 23),
    E_long: full27.slice(23, 27), E_short: eShort(full27.slice(23, 27)), C, N: cws, dataCodewords: [cws.length + 2, 902, ...cws] };
}

function countMatches(records, rule, ecLevel) {
  let matches = 0, applicable = 0;
  for (const r of records) {
    const v = evaluateRule(rule, r, { ecLevel });
    if (v === null) continue;
    if (typeof v !== 'boolean') fail('E_RULE_NOT_PREDICATE', 'hypothesis rule must evaluate to true/false/null');
    applicable++;
    if (v) matches++;
  }
  return { matches, applicable };
}

/**
 * Counterfactual randomization test (spec procedure): keep A, B, item, C;
 * replace D and/or E_long with uniform random digits; rebuild the payload;
 * recompute N; re-apply the SAME rule. Optionally permute C across records.
 */
export function randomizationTest({ records, rule, randomize = { D: true, E: false, C: false }, iterations = 1000,
  seed = 1, alternative = 'greater', ecLevel = 2, allowFewerIterations = false }) {
  if (!isArrayLike(records) || records.length === 0) fail('E_EMPTY', 'records is empty');
  requireInt(iterations, 'iterations', 1, 1e6);
  if (iterations < 1000 && !allowFewerIterations) fail('E_ITERATIONS', 'The specification requires at least 1000 iterations');
  if (!randomize.D && !randomize.E && !randomize.C) fail('E_NOTHING_RANDOMIZED', 'randomize at least one of D, E, C');
  const base = records.map((r) => fastRecord(r.full27, parseC(r.C)));
  const observed = countMatches(base, rule, ecLevel);
  const rng = new Pcg32(seed, 54);
  const simulated = [];
  for (let it = 0; it < iterations; it++) {
    const cs = base.map((r) => r.C);
    if (randomize.C) rng.shuffle(cs);
    const sim = base.map((r, i) => {
      const D = randomize.D ? rng.digits(9) : r.D;
      const E = randomize.E ? rng.digits(4) : r.E_long;
      return fastRecord(r.A + r.B + r.item + D + E, cs[i]);
    });
    simulated.push(countMatches(sim, rule, ecLevel).matches);
  }
  const m = mean(simulated);
  const sd = sampleStd(simulated);
  return {
    observed: observed.matches, applicable: observed.applicable, n: base.length,
    matchRate: observed.applicable ? observed.matches / observed.applicable : null,
    randomMean: m, randomStd: sd, z: zScore(observed.matches, m, sd),
    pValue: empiricalPValue(observed.matches, simulated, alternative),
    simulated, iterations, seed: String(seed), randomize: { ...randomize }, alternative,
  };
}

function groupKey(record, groupBy) {
  return groupBy.map((f) => (f === 'C' ? String(parseC(record.C)) : record[f])).join('|');
}

/** Deterministic group-aware split: all records of one batch land on the same side. */
export function splitTrainTest(records, { testFraction = 0.3, seed = 1, groupBy = ['A', 'B'] } = {}) {
  if (!(testFraction > 0 && testFraction < 1)) fail('E_RANGE', 'testFraction must be in (0,1)');
  const keys = [...new Set(records.map((r) => groupKey(r, groupBy)))].sort();
  new Pcg32(seed, 55).shuffle(keys);
  const testKeys = new Set(keys.slice(0, Math.max(1, Math.round(keys.length * testFraction))));
  const train = [], test = [];
  for (const r of records) (testKeys.has(groupKey(r, groupBy)) ? test : train).push(r);
  return { train, test, testGroups: [...testKeys].sort(), trainGroups: keys.filter((k) => !testKeys.has(k)).sort() };
}

/** Train/test evaluation; the randomization p-value is computed on the held-out set only. */
export function evaluateHypothesis({ records, rule, testFraction = 0.3, seed = 1, groupBy = ['A', 'B'], ecLevel = 2,
  randomize = { D: true, E: false, C: false }, iterations = 1000, allowFewerIterations = false, hypothesesTested = 1 }) {
  const split = splitTrainTest(records, { testFraction, seed, groupBy });
  const summarize = (set) => {
    const { matches, applicable } = countMatches(set.map((r) => fastRecord(r.full27, parseC(r.C))), rule, ecLevel);
    return { n: set.length, applicable, matches, rate: applicable ? matches / applicable : null };
  };
  const train = summarize(split.train);
  const test = summarize(split.test);
  const heldOut = split.test.length
    ? randomizationTest({ records: split.test, rule, randomize, iterations, seed, ecLevel, allowFewerIterations })
    : null;
  return { train, test, heldOutRandomization: heldOut, testGroups: split.testGroups, multipleTesting: multipleTestingNote(hypothesesTested) };
}

// ──────────────────────── consecutive-item analysis ────────────────────────────

export function consecutivePairs(records, { groupBy = ['A', 'B', 'C'] } = {}) {
  const groups = new Map();
  for (const r of records) {
    const k = groupKey(r, groupBy);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const pairs = [];
  for (const [key, list] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const byItem = [...list].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    for (let i = 0; i + 1 < byItem.length; i++) {
      if (smallIntFromDigits(byItem[i + 1].item) === smallIntFromDigits(byItem[i].item) + 1) pairs.push({ groupKey: key, a: byItem[i], b: byItem[i + 1] });
    }
  }
  return pairs;
}

export function comparePair(a, b) {
  const Na = numericGroupToCodewords(a.full27);
  const Nb = numericGroupToCodewords(b.full27);
  const nDiff = Na.map((v, i) => Nb[i] - v);
  const Ca = parseC(a.C), Cb = parseC(b.C);
  let cSelectedDiff = null, cSelectedDiffRank = null;
  if (Ca !== null && Ca === Cb) {
    cSelectedDiff = nDiff[Ca];
    cSelectedDiffRank = nDiff.filter((d) => Math.abs(d) < Math.abs(cSelectedDiff)).length;
  }
  const dA = BigInt(a.D), dB = BigInt(b.D);
  return {
    itemA: a.item, itemB: b.item,
    dChangedPositions: changedPositions(a.D, b.D), dHamming: hammingDistance(a.D, b.D),
    dNumericDiff: (dB - dA).toString(), dXor: (dA ^ dB).toString(), dModDiff929: modulo(dB - dA, 929),
    eNumericDiff: (BigInt(b.E_long) - BigInt(a.E_long)).toString(),
    nDiff, nModDiff929: nDiff.map((d) => ((d % 929) + 929) % 929), cSelectedDiff, cSelectedDiffRank,
  };
}

/** Binomial test of D digit changes between consecutive items against p = 9/10. */
export function digitChangeTest(pairs, p = '9/10') {
  let changed = 0, total = 0;
  for (const { a, b } of pairs) { changed += hammingDistance(a.D, b.D); total += a.D.length; }
  return { changed, total, ...binomialTestExact(changed, total, p) };
}

// ────────────────────────────── CSV import ─────────────────────────────────────

/** RFC-4180 CSV parser (quotes, escaped quotes, CRLF, BOM). All cells stay strings. */
export function parseCsv(text) {
  if (typeof text !== 'string') fail('E_NOT_STRING', 'CSV input must be text');
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], cell = '', i = 0, quoted = false;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1; continue;
    }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const HEADER_ALIASES = { a: 'A', b: 'B', c: 'C', item: 'item', d: 'D', e_long: 'E_long', elong: 'E_long', 'e long': 'E_long',
  full27: 'full27', full_27: 'full27', payload: 'full27', verified: 'verified' };
const SCI_RE = /^[0-9](\.[0-9]+)?[eE][+-]?[0-9]+$/;

/**
 * Import study records from CSV (columns A,B,C,Item,D,E_long,Full27 — or just Full27,C).
 * Never converts identifiers to numbers. Reports every problem instead of fixing it.
 */
export function importStudyCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { records: [], errors: [], duplicates: [], conflicts: [] };
  const header = rows[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] || null);
  if (!header.includes('full27') && !['A', 'B', 'item', 'D', 'E_long'].every((f) => header.includes(f))) {
    fail('E_CSV_HEADER', 'CSV needs Full27, or all of A,B,Item,D,E_long');
  }
  const errors = [];
  const parsed = [];
  rows.slice(1).forEach((cells, r) => {
    const line = r + 2;
    const get = (f) => { const i = header.indexOf(f); return i === -1 ? undefined : (cells[i] ?? '').trim(); };
    try {
      for (const f of ['full27', 'A', 'B', 'item', 'D', 'E_long']) {
        const v = get(f);
        if (v !== undefined && SCI_RE.test(v)) {
          fail('E_SCI_NOTATION', `${f}="${v}" was converted to scientific notation by a spreadsheet; digits are lost. Re-export the column as text.`);
        }
      }
      let full27 = get('full27');
      const parts = ['A', 'B', 'item', 'D', 'E_long'].map(get);
      if (full27 !== undefined && full27 !== '') {
        const f = parse27(full27);
        ['A', 'B', 'item', 'D', 'E_long'].forEach((name, i) => {
          if (parts[i] !== undefined && parts[i] !== '' && parts[i] !== f[name]) {
            fail('E_COMPONENT_MISMATCH', `${name}="${parts[i]}" does not match Full27 (${f[name]})`);
          }
        });
      } else {
        full27 = compose27({ A: parts[0], B: parts[1], item: parts[2], D: parts[3], E_long: parts[4] });
      }
      const v = get('verified');
      const verified = v === undefined || v === '' ? null : /^(1|true|yes|y)$/i.test(v) ? true : /^(0|false|no|n)$/i.test(v) ? false : fail('E_BAD_VERIFIED', `verified="${v}"`);
      parsed.push({ line, full27, C: parseC(get('C')), verified });
    } catch (err) {
      if (!(err instanceof Pdf417MathError)) throw err;
      errors.push({ line, code: err.code, message: err.message });
    }
  });
  const byKey = new Map();
  for (const p of parsed) { if (!byKey.has(p.full27)) byKey.set(p.full27, []); byKey.get(p.full27).push(p); }
  const records = [], duplicates = [], conflicts = [];
  for (const [full27, list] of byKey) {
    const cs = new Set(list.map((p) => p.C));
    if (cs.size > 1) { conflicts.push({ full27, lines: list.map((p) => p.line), C: [...cs] }); continue; }
    if (list.length > 1) duplicates.push({ full27, lines: list.map((p) => p.line) });
    const rec = buildStudyRecord(full27, { c: list[0].C });
    rec.verified = list.some((p) => p.verified === true) ? true : list[0].verified;
    rec.sourceLines = list.map((p) => p.line);
    records.push(rec);
  }
  return { records, errors, duplicates, conflicts };
}
