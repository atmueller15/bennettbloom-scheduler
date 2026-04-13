// ─────────────────────────────────────────────────────────────────
// Bennett & Bloom Intern Scheduler — Netlify Function (v2)
// ─────────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }
  const providedSecret = req.headers.get('x-api-secret');
  const expectedSecret = (typeof Netlify !== 'undefined' && Netlify.env) ? Netlify.env.get('API_SECRET') : process.env.API_SECRET;
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  let body;
  try { body = await req.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON', detail: e.message }), { status: 400 });
  }
  const { startDate, endDate } = body;
  function unwrap(input) {
    let arr = Array.isArray(input) ? input : (input && Array.isArray(input.value) ? input.value : []);
    return arr.map(item => {
      const out = {};
      for (const [key, val] of Object.entries(item)) {
        if (key.startsWith('@odata') || key === 'ItemInternalId' || key === 'ID' || key === 'Modified' || key === 'Created' || key === 'Author' || key === 'Editor') continue;
        out[key.replace(/_x0020_/g, '')] = val;
      }
      return out;
    });
  }
  const interns = unwrap(body.interns);
  const doctorLocations = unwrap(body.doctorLocations);
  const blackouts = unwrap(body.blackouts);
  const assignmentRules = unwrap(body.assignmentRules);
  const timeOff = unwrap(body.timeOff);
  const clinicSwitches = unwrap(body.clinicSwitches);
  if (!startDate || !endDate) {
    return new Response(JSON.stringify({ error: 'startDate and endDate are required' }), { status: 400 });
  }
  try {
    const schedule = generateSchedule({ startDate: new Date(startDate), endDate: new Date(endDate), interns, doctorLocations, blackouts, assignmentRules, timeOff, clinicSwitches });
    return new Response(JSON.stringify({ success: true, totalAssignments: schedule.length, schedule }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('Scheduling error:', err);
    return new Response(JSON.stringify({ error: 'Scheduling failed', detail: err.message }), { status: 500 });
  }
};
export const config = { path: '/api/generate-schedule' };
function generateSchedule({ startDate, endDate, interns, doctorLocations, blackouts, assignmentRules, timeOff, clinicSwitches }) {
  const assignments = [];
  const blackoutMap = buildBlackoutMap(blackouts);
  const timeOffMap = buildTimeOffMap(timeOff);
  const switchMap = buildSwitchMap(clinicSwitches);
  const internLocationCount = {};
  interns.forEach(i => { internLocationCount[i.Title] = {}; });
  for (const day of getWeekdays(startDate, endDate)) {
    const dateStr = fmtD(day);
    const doctorsToday = getDoctorsForDay(day, dateStr, doctorLocations, switchMap);
    if (doctorsToday.length === 0) continue;
    const available = interns.filter(i => !isOnTimeOff(i.Title, dateStr, timeOffMap));
    if (available.length === 0) continue;
    assignments.push(...assignDay({ date: dateStr, dayOfWeek: day.getDay(), doctors: doctorsToday, interns: available, blackoutMap, rulesMap: assignmentRules, internLocationCount }));
  }
  return assignments;
}
function assignDay({ date, dayOfWeek, doctors, interns, blackoutMap, rulesMap, internLocationCount }) {
  const results = [], assignedToday = new Set();
  for (const slot of [...doctors].sort((a,b) => (a.Location||'').localeCompare(b.Location||''))) {
    const { DoctorName, Location, MaxInterns = 1 } = slot;
    const slotsNeeded = parseInt(MaxInterns, 10) || 1;
    let filled = 0;
    const candidates = interns.filter(i => !assignedToday.has(i.Title) && !isBlackedOut(i.Title, DoctorName, date, blackoutMap) && meetsRules(i.Title, DoctorName, Location, dayOfWeek, rulesMap)).map(i => ({ i, score: (internLocationCount[i.Title]||{})[Location]||0 })).sort((a,b) => a.score - b.score);
    for (const { i } of candidates) {
      if (filled >= slotsNeeded) break;
      results.push({ Date: date, InternName: i.Title, DoctorName, Location, Status: 'Assigned' });
      internLocationCount[i.Title][Location] = (internLocationCount[i.Title][Location]||0) + 1;
      assignedToday.add(i.Title); filled++;
    }
    for (let x = filled; x < slotsNeeded; x++) results.push({ Date: date, InternName: 'UNASSIGNED', DoctorName, Location, Status: 'Unassigned' });
  }
  return results;
}
function buildBlackoutMap(bl) { const m = {}; for (const b of bl) { const i=(b.InternName||'').trim(), d=(b.DoctorName||'').trim(); if(!i||!d) continue; if(b.BlackoutDate) m[i+'|'+d+'|'+fmtD(new Date(b.BlackoutDate))]=true; else m[i+'|'+d]=true; } return m; }
function isBlackedOut(n,d,ds,m) { return !!(m[n+'|'+d+'|'+ds]||m[n+'|'+d]); }
function buildTimeOffMap(to) { const m = {}; for (const t of to) { if(t.Status==='Denied') continue; const i=(t.InternName||'').trim(), s=new Date(t.StartDate), e=new Date(t.EndDate||t.StartDate); for(let d=new Date(s);d<=e;d.setDate(d.getDate()+1)) m[i+'|'+fmtD(new Date(d))]=true; } return m; }
function isOnTimeOff(n,ds,m) { return !!m[n+'|'+ds]; }
function meetsRules(iN,dN,loc,dow,rules) { for (const r of rules) { const ri=(r.InternName||'').trim(),rd=(r.DoctorName||'').trim(),rl=(r.Location||'').trim(),rds=(r.DaysOfWeek||'').split(',').map(x=>x.trim()).filter(Boolean),rt=(r.RuleType||'Deny').trim(); if((!ri||ri===iN)&&(!rd||rd===dN)&&(!rl||rl===loc)&&(rds.length===0||rds.includes(String(dow))||rds.some(x=>x.toLowerCase()===dayName(dow).toLowerCase()))) { if(rt==='Deny') return false; } } return true; }
function buildSwitchMap(sw) { const m = {}; for (const s of sw) { const d=(s.DoctorName||'').trim(); if(!s.SwitchDate||!d) continue; m[d+'|'+fmtD(new Date(s.SwitchDate))]={NewLocation:s.NewLocation||s.Location||'',NewDoctorName:s.NewDoctorName||d}; } return m; }
function getDoctorsForDay(day,ds,dl,sm) { const dow=day.getDay(),da=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow],r=[]; for(const d of dl){const ad=(d.ActiveDays||'').split(',').map(x=>x.trim()).filter(Boolean);if(ad.length>0&&!ad.some(x=>x===da||x===String(dow)||x.toLowerCase()===dayName(dow).toLowerCase())) continue;const dn=(d.DoctorName||d.Title||'').trim(),sw=sm[dn+'|'+ds];r.push({DoctorName:sw?(sw.NewDoctorName||dn):dn,Location:sw?sw.NewLocation:(d.Location||''),MaxInterns:d.MaxInterns||1});} return r; }
function getWeekdays(s,e) { const days=[],d=new Date(s),en=new Date(e); d.setHours(0,0,0,0); en.setHours(23,59,59,999); while(d<=en){if(d.getDay()!==0&&d.getDay()!==6) days.push(new Date(d)); d.setDate(d.getDate()+1);} return days; }
function fmtD(d) { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function dayName(dow) { return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow]; }
