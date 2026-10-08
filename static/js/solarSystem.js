// JPL's approximate Keplerian elements, fitted for 1800–2050 (J2000 ecliptic).
// https://ssd.jpl.nasa.gov/planets/approx_pos.html — Table 1 and equations 1–5.
// Earth uses the Earth–Moon barycentre. UTC approximates TDB for this decorative
// view; this is not a navigation ephemeris. Display distances are compressed.
const ELEMENTS = [
  ['Mercury', [.38709927,.20563593,7.00497902,252.25032350,77.45779628,48.33076593], [.00000037,.00001906,-.00594749,149472.67411175,.16047689,-.12534081]],
  ['Venus', [.72333566,.00677672,3.39467605,181.97909950,131.60246718,76.67984255], [.00000390,-.00004107,-.00078890,58517.81538729,.00268329,-.27769418]],
  ['Earth', [1.00000261,.01671123,-.00001531,100.46457166,102.93768193,0], [.00000562,-.00004392,-.01294668,35999.37244981,.32327364,0]],
  ['Mars', [1.52371034,.09339410,1.84969142,-4.55343205,-23.94362959,49.55953891], [.00001847,.00007882,-.00813131,19140.30268499,.44441088,-.29257343]],
  ['Jupiter', [5.20288700,.04838624,1.30439695,34.39644051,14.72847983,100.47390909], [-.00011607,-.00013253,-.00183714,3034.74612775,.21252668,.20469106]],
  ['Saturn', [9.53667594,.05386179,2.48599187,49.95424423,92.59887831,113.66242448], [-.00125060,-.00050991,.00193609,1222.49362201,-.41897216,-.28867794]],
  ['Uranus', [19.18916464,.04725744,.77263783,313.23810451,170.95427630,74.01692503], [-.00196176,-.00004397,-.00242939,428.48202785,.40805281,.04240589]],
  ['Neptune', [30.06992276,.00859048,1.77004347,-55.12002969,44.96476227,131.78422574], [.00026291,.00005105,.00035372,218.45945325,-.32241464,-.00508664]],
];
const RAD = Math.PI / 180;

export function orbitalPoint(planet, eccentricAnomaly) {
  const {a,e,i,peri,node} = planet;
  const x = a * (Math.cos(eccentricAnomaly) - e);
  const y = a * Math.sqrt(1 - e*e) * Math.sin(eccentricAnomaly);
  const w = peri-node, cw = Math.cos(w), sw = Math.sin(w);
  const cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(i);
  return {x:(cw*cn-sw*sn*ci)*x+(-sw*cn-cw*sn*ci)*y,
    y:(cw*sn+sw*cn*ci)*x+(-sw*sn+cw*cn*ci)*y,
    z:sw*Math.sin(i)*x+cw*Math.sin(i)*y};
}

export function solarSystemAt(date = new Date()) {
  const milliseconds = date.getTime();
  const year = date.getUTCFullYear();
  if (!Number.isFinite(milliseconds) || year < 1800 || year > 2050) return [];
  const t = (milliseconds / 86400000 + 2440587.5 - 2451545) / 36525;
  return ELEMENTS.map(([name,base,rate]) => {
    const [a,e,i,l,peri,node] = base.map((v,n) => v+rate[n]*t);
    const m = ((l-peri+180)%360+360)%360*RAD-Math.PI;
    let eccentricAnomaly = m;
    for (let n=0;n<12;n++) {
      const delta = (eccentricAnomaly-e*Math.sin(eccentricAnomaly)-m)/(1-e*Math.cos(eccentricAnomaly));
      eccentricAnomaly -= delta;
      if (Math.abs(delta)<1e-12) break;
    }
    const planet = {name,a,e,i:i*RAD,peri:peri*RAD,node:node*RAD};
    return {...planet,...orbitalPoint(planet,eccentricAnomaly)};
  });
}

// Small vector pictograms, avoiding coloured emoji and platform-dependent fonts.
function drawPlanet(ctx,name,x,y,r) {
  ctx.save(); ctx.translate(x,y); ctx.lineWidth=1;
  ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  if (name==='Saturn') ctx.ellipse(0,0,r*1.8,r*.55,-.4,0,Math.PI*2);
  if (name==='Earth') {ctx.ellipse(0,0,r*.45,r,0,0,Math.PI*2);ctx.moveTo(-r,0);ctx.lineTo(r,0);}
  if (name==='Jupiter') {for(const y of [-.4,.4]){ctx.moveTo(-r*.85,r*y);ctx.lineTo(r*.85,r*y);}}
  if (name==='Uranus') ctx.ellipse(0,0,r*.55,r*1.6,.35,0,Math.PI*2);
  if (name==='Venus') {ctx.moveTo(0,r);ctx.lineTo(0,r+4);ctx.moveTo(-2,r+2);ctx.lineTo(2,r+2);}
  if (name==='Mars') {ctx.moveTo(r*.7,-r*.7);ctx.lineTo(r+3,-r-3);ctx.lineTo(r,-r-3);ctx.moveTo(r+3,-r-3);ctx.lineTo(r+3,-r);}
  if (name==='Mercury') ctx.arc(0,-r-2,3,0,Math.PI);
  if (name==='Neptune') {ctx.moveTo(0,-r);ctx.lineTo(0,-r-4);ctx.moveTo(-3,-r-4);ctx.lineTo(3,-r-4);}
  ctx.stroke(); ctx.restore();
}

export function initSolarSystem() {
  const canvas = document.createElement('canvas');
  canvas.id='solar-system-canvas'; canvas.setAttribute('aria-hidden','true');
  canvas.style.cssText='position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;opacity:var(--bg-effect-intensity,1)';
  const ctx=canvas.getContext('2d');
  if (!ctx) return {cleanup(){},refresh(){}};
  document.body.prepend(canvas);
  function refresh() {
    if(document.hidden) return;
    const width=innerWidth,height=innerHeight,dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
    const style=getComputedStyle(document.documentElement);
    const color=style.getPropertyValue('--bg-effect-color').trim()||style.getPropertyValue('--fg').trim();
    const size=parseFloat(style.getPropertyValue('--bg-effect-size'))||1;
    const planets=solarSystemAt();
    if(!planets.length)return;
    const cx=width*.55,cy=height*.46,scale=Math.min(width,height)*.54*size;
    function project(p,planet) {
      // Each orbit is uniformly rescaled: keep eccentricity, orientation and
      // date-derived phase, while spreading the inner orbits enough to read.
      const factor=Math.pow(planet.a/30.07,.38)*scale/planet.a;
      const x=p.x*factor,y=p.y*factor,z=p.z*factor;
      return {x:cx+x*Math.cos(-.35)-y*.62*Math.sin(-.35),
        y:cy+x*Math.sin(-.35)+y*.62*Math.cos(-.35)-z*.75};
    }
    ctx.strokeStyle=color;ctx.lineWidth=1;
    for(const planet of planets) {
      ctx.globalAlpha=.1;ctx.beginPath();
      for(let n=0;n<=180;n++) {
        const p=project(orbitalPoint(planet,n*Math.PI/90),planet);
        if(n)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);
      }
      ctx.stroke();
      const p=project(planet,planet);
      ctx.globalAlpha=.5;ctx.fillStyle=style.getPropertyValue('--bg').trim()||'#100f14';
      drawPlanet(ctx,planet.name,p.x,p.y,planet.name==='Jupiter'?7:5);
    }
    ctx.globalAlpha=.45;ctx.beginPath();ctx.arc(cx,cy,6,0,Math.PI*2);ctx.stroke();
    ctx.beginPath();ctx.arc(cx,cy,1,0,Math.PI*2);ctx.stroke();
    ctx.globalAlpha=1;
  }
  window.addEventListener('resize',refresh);
  document.addEventListener('visibilitychange',refresh);
  // Real-time orbital motion is slow. No animation loop or accelerated clock.
  const timer=setInterval(refresh,60000);
  refresh();
  return {refresh,cleanup(){clearInterval(timer);window.removeEventListener('resize',refresh);document.removeEventListener('visibilitychange',refresh);canvas.remove();}};
}
