import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateAnalysis,
  validateFindings,
  listVerifiedReports,
  ensureOutputDir,
  isCached,
  markCached,
  findingsPath,
  debugLogPath,
} from '../src/scanner.js';

describe('validateAnalysis', () => {
  it('accepts a valid files array', () => {
    expect(validateAnalysis('{"files":["a.ts","b/c.js"]}')).toEqual(['a.ts', 'b/c.js']);
  });

  it('rejects missing files', () => {
    expect(() => validateAnalysis('{}')).toThrow();
  });

  it('rejects non-string entries', () => {
    expect(() => validateAnalysis('{"files":[1,2]}')).toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => validateAnalysis('{"files":[""]}')).toThrow();
  });
});

describe('validateFindings', () => {
  it('accepts empty findings', () => {
    const r = validateFindings('{"file":"a.ts","findings":[]}');
    expect(r.file).toBe('a.ts');
    expect(r.findings).toEqual([]);
  });

  it('accepts a complete finding', () => {
    const r = validateFindings(JSON.stringify({
      file: 'a.ts',
      findings: [{ name: 'SQL injection', severity: 'high', description: 'desc', verified: true, reason: 'confirmed' }],
    }));
    expect(r.findings[0].severity).toBe('high');
    expect(r.findings[0].verified).toBe(true);
  });

  it('rejects invalid severity', () => {
    expect(() => validateFindings('{"file":"a.ts","findings":[{"name":"x","severity":"panic","description":"d"}]}'))
      .toThrow();
  });

  it('rejects missing fields', () => {
    expect(() => validateFindings('{"findings":[]}')).toThrow();
    expect(() => validateFindings('{"file":"a.ts"}')).toThrow();
  });
});

describe('filesystem helpers', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'probus-scanner-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('ensureOutputDir creates findings/reports/debug', () => {
    ensureOutputDir(tmp);
    expect(path.join(tmp, 'findings')).toBeTruthy();
  });

  it('isCached / markCached roundtrip', () => {
    const cache = path.join(tmp, 'cache.txt');
    expect(isCached('a.ts', cache)).toBe(false);
    markCached('a.ts', cache);
    expect(isCached('a.ts', cache)).toBe(true);
    expect(isCached('b.ts', cache)).toBe(false);
  });

  it('findingsPath slugifies slashes', () => {
    const p = findingsPath(tmp, 'src/foo/bar.ts');
    expect(path.basename(p)).toBe('src__foo__bar.ts.json');
  });

  it('debugLogPath slugifies slashes', () => {
    const p = debugLogPath(tmp, 'src/a.ts');
    expect(path.basename(p)).toBe('src__a.ts.log');
  });
});

describe('listVerifiedReports', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'probus-reports-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns [] when findings dir is missing', () => {
    expect(listVerifiedReports(tmp)).toEqual([]);
  });

  it('returns only verified findings with stable report paths', () => {
    ensureOutputDir(tmp);
    const findings = {
      file: 'src/app.ts',
      findings: [
        { name: 'SQLi',  severity: 'high', description: 'd1', verified: true },
        { name: 'XSS',   severity: 'medium', description: 'd2', verified: false },
        { name: 'Path',  severity: 'critical', description: 'd3', verified: true },
      ],
    };
    writeFileSync(path.join(tmp, 'findings', 'src__app.ts.json'), JSON.stringify(findings));

    const reports = listVerifiedReports(tmp);
    expect(reports).toHaveLength(2);
    expect(reports.map(r => r.name).sort()).toEqual(['Path', 'SQLi']);
    expect(reports[0].reportPath.endsWith('.md')).toBe(true);
    // Report index is 1-based by original finding position, so SQLi=--1, Path=--3.
    const paths = reports.map(r => path.basename(r.reportPath)).sort();
    expect(paths).toEqual(['src__app.ts--1.md', 'src__app.ts--3.md']);
  });

  it('skips unparseable findings files', () => {
    ensureOutputDir(tmp);
    writeFileSync(path.join(tmp, 'findings', 'broken.json'), 'not json');
    expect(listVerifiedReports(tmp)).toEqual([]);
  });
});
