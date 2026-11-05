import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  healthAlert, healthRows, parseBatt, parseCelsius, parseDf, parseDockerDf, parseDu, parseSize, parseSysctl, parseTherm, parseVmStat,
  statusLine, type Health,
} from '../mod/hooks/core.ts';

// Captured on an M2 Pro MacBook on 2026-11-05.
const sample = (f: string) => readFileSync(new URL(`./fixtures/health/${f}`, import.meta.url), 'utf8');

test('df on APFS folds / and the data volume into one row', () => {
  assert.deepEqual(parseDf(sample('df.txt')), [{ mount: '/ + /System/Volumes/Data', totalB: 482797652 * 1024, freeB: 11281168 * 1024 }]);
});

test('df keeps separate rows when the volumes differ', () => {
  const text = 'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk1s1 1000 100 900 10% 1 1 0% /\n/dev/disk2s1 2000 100 1900 5% 1 1 0% /Volumes/My Data\n';
  assert.deepEqual(parseDf(text).map(d => d.mount), ['/', '/Volumes/My Data']);
});

test('vm_stat used memory counts app, wired and compressed pages', () => {
  assert.equal(parseVmStat(sample('vm_stat.txt')), (962697 - 565 + 265505 + 333251) * 16384);
});

test('sysctl gives load, cores, boot time, swap and pressure', () => {
  assert.deepEqual(parseSysctl(sample('sysctl.txt')), {
    memB: 34359738368, load: [10.78, 10.77, 11.92], cpus: 12, pCores: 8, eCores: 4, bootS: 1784480757,
    swapB: 11889.06 * 1024 * 1024, pressure: 'normal',
  });
  assert.equal(parseSysctl('kern.memorystatus_vm_pressure_level: 2\n').pressure, 'warn');
  assert.equal(parseSysctl('kern.memorystatus_vm_pressure_level: 4\n').pressure, 'critical');
});

test('pmset batt reads charging laptops, unplugged laptops and desktops', () => {
  assert.deepEqual(parseBatt(sample('batt.txt')), { source: 'AC Power', pct: 99, state: 'finishing charge', remaining: '0:24' });
  assert.deepEqual(parseBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t42%; discharging; 3:10 remaining present: true\n"),
    { source: 'Battery Power', pct: 42, state: 'discharging', remaining: '3:10' });
  assert.deepEqual(parseBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging; (no estimate) present: true\n").remaining, null);
  assert.deepEqual(parseBatt("Now drawing from 'AC Power'\n"), { source: 'AC Power', pct: null, state: '', remaining: null });
});

test('pmset therm reads throttling only once macOS has recorded it', () => {
  assert.deepEqual(parseTherm(sample('therm.txt')), { speedLimit: null, warning: null });
  assert.deepEqual(parseTherm('CPU Power notify\n\tCPU_Scheduler_Limit \t= 100\n\tCPU_Available_CPUs \t= 12\n\tCPU_Speed_Limit \t= 70\nThermal Warning Level = 2\n'), { speedLimit: 70, warning: 2 });
});

test('temperature tools parse to celsius, a zero reading to nothing', () => {
  assert.equal(parseCelsius('61.2°C\n'), 61.2);
  assert.equal(parseCelsius('CPU: 55.0 °C'), 55);
  assert.equal(parseCelsius('48.3\n'), 48.3);
  assert.equal(parseCelsius('0.0°C'), null);
  assert.equal(parseCelsius(''), null);
});

test('docker df sizes, with a negative reclaimable as unknown', () => {
  assert.equal(parseSize('880.6kB'), 880600);
  assert.equal(parseSize('0B'), 0);
  assert.deepEqual(parseDockerDf(sample('docker.jsonl')), [
    { type: 'Images', sizeB: 10.4e9, reclaimB: null },
    { type: 'Containers', sizeB: 880600, reclaimB: 147500 },
    { type: 'Local Volumes', sizeB: 21.63e9, reclaimB: 15.28e9 },
    { type: 'Build Cache', sizeB: 0, reclaimB: 0 },
  ]);
  assert.equal(parseDu('7486584\t/Users/x/.herdr/worktrees\n'), 7486584 * 1024);
});

const now = Date.parse('2026-11-05T12:00:00Z');
const machine = (o: { freeGB?: number; pressure?: 'normal' | 'warn' | 'critical'; speedLimit?: number | null; tempC?: number | null } = {}): Health => {
  const sys = parseSysctl(sample('sysctl.txt'));
  return {
    fast: {
      disks: [{ mount: '/', totalB: 494e9, freeB: (o.freeGB ?? 100) * 1e9 }], memUsedB: 25.6e9,
      sys: { ...sys, pressure: o.pressure ?? 'normal' }, power: parseBatt(sample('batt.txt')),
      therm: { speedLimit: o.speedLimit ?? null, warning: null },
    },
    slow: { docker: parseDockerDf(sample('docker.jsonl')), worktreesB: 7.67e9, tempC: o.tempC ?? null },
  };
};

test('the health tab reads the captured machine as text', () => {
  assert.deepEqual(healthRows(machine({ freeGB: 11.55 }), now).map(r => `${r.level} ${r.label}: ${r.value}`), [
    'crit disk: 11.6 GB free of 494 GB · /',
    'ok memory: 25.6 GB used of 34.4 GB · pressure normal · swap 12.5 GB',
    'ok load: 10.78 10.77 11.92 · 12 cores (8P+4E) · 90% per core',
    'ok temp: not readable without sudo',
    'ok power: 99% · finishing charge · 0:24 to full · AC Power',
    'ok uptime: 108d 18h',
    'ok docker: 32.0 GB · images 10.4 GB · containers 881 kB (148 kB free-able) · volumes 21.6 GB (15.3 GB free-able)',
    'ok worktrees: 7.7 GB in ~/.herdr/worktrees',
  ]);
});

test('thresholds: disk under 30 GB amber, under 15 GB red; pressure and heat warn', () => {
  const level = (h: Health, label: string) => healthRows(h, now).find(r => r.label === label)!.level;
  assert.deepEqual([level(machine({ freeGB: 31 }), 'disk'), level(machine({ freeGB: 29 }), 'disk'), level(machine({ freeGB: 14 }), 'disk')], ['ok', 'warn', 'crit']);
  assert.deepEqual([level(machine({ pressure: 'warn' }), 'memory'), level(machine({ pressure: 'critical' }), 'memory')], ['warn', 'crit']);
  assert.deepEqual([level(machine({ tempC: 70 }), 'temp'), level(machine({ tempC: 85 }), 'temp'), level(machine({ tempC: 97 }), 'temp'), level(machine({ speedLimit: 80 }), 'temp')], ['ok', 'warn', 'crit', 'warn']);
  assert.equal(healthRows(machine({ speedLimit: 80 }), now).find(r => r.label === 'temp')!.value, 'not readable without sudo · throttled to 80%');
});

test('an alert names the bad readings and reaches the status line', () => {
  assert.equal(healthAlert(healthRows(machine(), now)), null);
  const alert = healthAlert(healthRows(machine({ freeGB: 20, pressure: 'critical' }), now));
  assert.deepEqual(alert, { level: 'crit', text: 'disk 20.0 GB free · memory pressure critical' });
  assert.equal(statusLine({ nodes: [], idle: 0, bus: [], decisions: [], flows: [] }, alert), `orch · 0 working · ⚠ ${alert!.text}`);
});

test('before the first reading the tab says so', () => {
  assert.deepEqual(healthRows({ fast: null, slow: null }, now).map(r => r.value), ['reading…']);
});
