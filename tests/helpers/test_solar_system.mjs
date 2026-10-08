import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('../../static/js/solarSystem.js', import.meta.url), 'utf8');
const {solarSystemAt} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
// Independent geometric heliocentric vectors from JPL Horizons, J2000 ecliptic,
// AU, TDB epochs. The approximation's published nominal errors guide tolerance.
// https://ssd.jpl.nasa.gov/api/horizons.api (COMMAND=1/3/8, CENTER=500@10,
// EPHEM_TYPE=VECTORS, VEC_TABLE=2, OUT_UNITS=AU-D, TLIST=2451545.0/2461322.0).
const references = [
  ['2000-01-01T12:00:00Z', 'Mercury', [-.1300936053754522,-.4472876181353563,-.02459830695805179], .0001],
  ['2000-01-01T12:00:00Z', 'Earth', [-.1771587841839055,.9672193524609504,-.000001139275508446145], .00015],
  ['2000-01-01T12:00:00Z', 'Neptune', [16.81204696805288,-24.99176288928469,.1272228799202476], .01],
  ['2026-10-08T12:00:00Z', 'Mercury', [.1437828339665452,-.4233067404740924,-.04778160800476899], .0001],
  ['2026-10-08T12:00:00Z', 'Earth', [.9657961489877441,.2561873310322304,-.00002142563853097248], .00015],
  ['2026-10-08T12:00:00Z', 'Neptune', [29.8362745377928,1.403792547527928,-.7164766962489015], .01],
];
for(const [date,name,xyz,tolerance] of references) test(`${name} agrees with Horizons at ${date}`,()=>{
  const p=solarSystemAt(new Date(date)).find(p=>p.name===name);
  const error=Math.hypot(p.x-xyz[0],p.y-xyz[1],p.z-xyz[2]);
  assert.ok(error<tolerance,`Vector error ${error} AU exceeds ${tolerance}`);
});
test('rejects invalid dates and dates outside the element fit',()=>{
  for(const date of ['invalid','1799-12-31','2051-01-01']) assert.deepEqual(solarSystemAt(new Date(date)),[]);
});
