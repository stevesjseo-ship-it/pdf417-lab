// selfTest.js — runs inside the app on every load. Expected values are literals
// from the specification (independent of pdf417Math.js). Pass the loaded module:
//   const results = runSelfTest(M);   // [{ id, name, pass, detail }]
// Any failure means the math module is not the audited version: block analysis.

const FULL27 = '171811492360069186481244870';
const N = [3, 22, 166, 657, 504, 495, 626, 774, 338, 670];
const STREAM = [12, 902, 3, 22, 166, 657, 504, 495, 626, 774, 338, 670];
const EC = [452, 170, 213, 366, 511, 345, 618, 301];
const ALL20 = [...STREAM, ...EC];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return e && e.code === code; } };

export const SELF_TEST_VERSION = '1.0.0';

export function runSelfTest(M) {
  const cases = [
    ['A1', 'Field split A|B|ITEM|D|E_LONG', () => same(M.parse27(FULL27), { full27: FULL27, A: '1718', B: '1149236', item: '006', D: '918648124', E_long: '4870' })],
    ['A2', 'E_short 4870→885, 6981→005', () => M.eShort('4870') === '885' && M.eShort('6981') === '005'],
    ['A3', 'Numeric compaction N0..N9', () => same(M.decimalToBase900(FULL27), N)],
    ['A4', 'Base-900 value with sentinel', () => M.numericDecodeWork(N).value === '1171811492360069186481244870'],
    ['A5', 'Decode removes sentinel', () => M.base900ToDecimal(N).payload === FULL27],
    ['A6', 'Data stream [12, 902, N…]', () => same(M.buildNumericDataCodewords(FULL27), STREAM)],
    ['A7', 'EC codewords (level 2)', () => same(M.computeErrorCorrection(STREAM, 2), EC)],
    ['A8', '4×5 layout', () => same(M.buildPhysicalLayout({ codewords: ALL20, rows: 4, cols: 5, ecLevel: 2 }).map((r) => r.codewords),
      [[12, 902, 3, 22, 166], [657, 504, 495, 626, 774], [338, 670, 452, 170, 213], [366, 511, 345, 618, 301]])],
    ['A9', 'Row indicators (1,4)(6,1)(4,6)(31,34)', () => same(M.buildPhysicalLayout({ codewords: ALL20, rows: 4, cols: 5, ecLevel: 2 }).map((r) => [r.left, r.right]), [[1, 4], [6, 1], [4, 6], [31, 34]])],
    ['A10', 'C selector N[2] = 166', () => M.cSelector(2, N).value === 166],
    ['A11', 'D path', () => same(M.selectorPath('918648124', N).map((s) => s.value), [670, 22, 338, 626, 504, 338, 22, 166, 504])],
    ['A12', 'E path', () => same(M.selectorPath('4870', N).map((s) => s.value), [504, 338, 774, 3])],
    ['A13', 'Syndromes of known symbol all zero', () => same(M.rsSyndromes(ALL20, 2), [0, 0, 0, 0, 0, 0, 0, 0])],
    ['A14', 'End-to-end decode of 20 codewords', () => M.analyzeCodewords({ codewords: ALL20, rows: 4, cols: 5, c: 2 }).study.E_short === '885'],
    ['R1', 'Spec run example → 4,1,1,2,1,3,1,4 / 125200 / cluster 3', () => {
      const r = M.normalizeCodewordRuns([16.1, 4.0, 3.8, 8.2, 4.1, 11.9, 4.0, 16.0]);
      return same(r.runs, [4, 1, 1, 2, 1, 3, 1, 4]) && r.patternInt === 125200 && r.cluster === 3;
    }],
    ['R2', 'Start/stop patterns 0x1fea8 / 0x3fa29', () => M.modulesToInteger(M.runsToModules([8, 1, 1, 1, 1, 1, 1, 3])) === 0x1fea8 && M.modulesToInteger(M.runsToModules([7, 1, 1, 3, 1, 1, 1, 2, 1])) === 0x3fa29],
    ['R3', 'Single-error locator repairs index 7', () => { const b = ALL20.slice(); b[7] = 496; const f = M.rsLocateSingleError(b, 2); return f && f.position === 7 && f.correctedValue === 495; }],
    ['G1', 'Number input refused for full27', () => throwsCode(() => M.parse27(171811492360069186481244870), 'E_NOT_STRING')],
    ['G2', 'Blank C is missing, not 0', () => M.parseC('') === null && throwsCode(() => M.cSelector('', N), 'E_C_REQUIRED')],
    ['G3', 'Garbage pixel runs refused', () => throwsCode(() => M.normalizeCodewordRuns([0, 0, 0, 0, 0, 0, 0, 0]), 'E_BAD_PIXEL_RUN')],
    ['G4', 'digitSum(full27) = 111', () => M.digitSum(FULL27) === 111],
    ['S1', 'PCG32(42,54) reference stream', () => { const g = new M.Pcg32(42, 54); return same([g.nextUint32(), g.nextUint32(), g.nextUint32()], [0xa15c02b7, 0x7b47f409, 0xba1d3330]); }],
    ['S2', 'Exact binomial 19/100', () => { const t = M.binomialTestExact(1, 2, '9/10'); return t.lower.numerator === '19' && t.lower.denominator === '100'; }],
  ];
  return cases.map(([id, name, fn]) => {
    try { const pass = fn() === true; return { id, name, pass, detail: pass ? '' : 'wrong result' }; }
    catch (e) { return { id, name, pass: false, detail: `threw ${e && (e.code || e.message)}` }; }
  });
}
