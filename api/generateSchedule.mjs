// Bennett & Bloom Intern Scheduler — Vercel Serverless Function
// POST /api/generateSchedule
// Body: { startDate, endDate, interns, doctorLocations, blackouts, assignmentRules, timeOff, clinicSwitches }
// Header: x-api-secret: <API_SECRET env var>

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const providedSecret = req.headers['x-api-secret'];
  const expectedSecret = process.env.API_SECRET;
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body;
  if (!body) {
    return res.status(400).json({ error: 'Empty body' });
  

  const { startDate, endDate } = body;

  function unwrap(input) {
    let arr = Array.isArray(input) ? input : (input && Array.isArray(input.value) ? input.value : []);
    return arr.map(item => {
      const out = {};
      for (const [key, val] of Object.entries(item)) {
        if (key.startsWith('@odata') || key === 'ItemInternalId' || key === 'ID' || key === 'Modified' || key === 'Created' || key === 'Author' || key === 'Editor') continue;
        const cleanKey = key.replace(/_x0020_/g, '');
        out[cleanKey] = val;
      }
      return out;
    });
  }

  const interns         = unwrap(body.interns);
  const doctorLocations = unwrap(body.doctorLocations);
  const blackouts       = unwrap(body.blackouts);
  const assignmentRules = unwrap(body.assignmentRules);
  const timeOff         = unwrap(body.timeOff);
  const clinicSwitches  = unwrap(body.clinicSwitches);

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate are required' });
  }

  try {
    const schedule = generateSchedule({
      startDate: new Date(startDate),
      endDate:   new Date(endDate),
      interns, doctorLocations, blackouts, assignmentRules, timeOff, clinicSwitches
    });
    return res.status(200).json({ success: true, totalAssignments: schedule.length, schedule });
  } catch (err) {
    console.error('Scheduling error:', err);
    return res.status(500).json({ error: 'Scheduling failed', detail: err.message });
  }
}

function generateSchedule({ startDate, endDate, interns, doctorLocations, blackouts, assignmentRules, timeOff, clinicSwitches }) {
  const assignments = [];
  const blackoutMap  = buildBlackoutMap(blackouts);
  const timeOffMap   = buildTimeOffMap(timeOff);
  const rulesMap     = assignmentRules;
  const switchMap    = buildSwitchMap(clinicSwitches);
  const internLocationCount = {};
  interns.forEach(i => { internLocationCount[i.Title] = {}; });

  for (const day of getWeekdays(startDate, endDate)) {
    const dateStr      = formatDate(day);
    const doctorsToday = getDoctorsForDay(day, dateStr, doctorLocations, switchMap);
    if (doctorsToday.length === 0) continue;
    const available = interns.filter(i => !isOnTimeOff(i.Title, dateStr, timeOffMap));
    if (available.length === 0) continue;
    assignments.push(...assignInternsToLocations({
      date: dateStr, dayOfWeek: day.getDay(), doctors: doctorsToday,
      interns: available, blackoutMap, rulesMap, internLocationCount
    }));
  }
  return assignments;
}

function assignInternsToLocations({ date, dayOfWeek, doctors, interns, blackoutMap, rulesMap, internLocationCount }) {
  const results = [];
  const assignedToday = new Set();
  for (const slot of [...doctors].sort((a, b) => (a.Location || '').localeCompare(b.Location || ''))) {
    const { DoctorName, Location, MaxInterns = 1 } = slot;
    const slotsNeeded = parseInt(MaxInterns, 10) || 1;
    let filled = 0;
    const candidates = interns
      .filter(intern =>
        !assignedToday.has(intern.Title) &&
        !isBlackedOut(intern.Title, DoctorName, date, blackoutMap) &&
        meetsRules(intern.Title, DoctorName, Location, dayOfWeek, rulesMap)
      )
      .map(intern => ({ intern, score: (internLocationCount[intern.Title] || {})[Location] || 0 }))
      .sort((a, b) => a.score - b.score);
    for (const { intern } of candidates) {
      if (filled >= slotsNeeded) break;
      results.push({ Date: date, InternName: intern.Title, DoctorName, Location, Status: 'Assigned' });
      internLocationCount[intern.Title][Location] = (internLocationCount[intern.Title][Location] || 0) + 1;
      assignedToday.add(intern.Title);
      filled++;
    }
    for (let i = filled; i < slotsNeeded; i++) {
      results.push({ Date: date, InternName: 'UNASSIGNED', DoctorName, Location, Status: 'Unassigned' });
    }
  }
  return results;
}

function buildBlackoutMap(blackouts) {
  const map = {};
  for (const b of blackouts) {
    const intern = (b.InternName || '').trim();
    const doctor = (b.DoctorName || '').trim();
    if (!intern || !doctor) continue;
    if (b.BlackoutDate) {
      map[`${intern}|${doctor}|${formatDate(new Date(b.BlackoutDate))}`] = true;
    } else {
      map[`${intern}|${doctor}`] = true;
    }
  }
  return map;
}

function isBlackedOut(internName, doctorName, dateStr, map) {
  return !!(map[`${internName}|${doctorName}|${dateStr}`] || map[`${internName}|${doctorName}`]);
}

function buildTimeOffMap(timeOff) {
  const map = {};
  for (const t of timeOff) {
    if (t.Status === 'Denied') continue;
    const intern = (t.InternName || '').trim();
    const start  = new Date(t.StartDate);
    const end    = new Date(t.EndDate || t.StartDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      map[`${intern}|${formatDate(new Date(d))}`] = true;
    }
  }
  return map;
}

function isOnTimeOff(internName, dateStr, map) {
  return !!map[`${internName}|${dateStr}`];
}

function meetsRules(internName, doctorName, location, dayOfWeek, rules) {
  for (const rule of rules) {
    const rIntern   = (rule.InternName  || '').trim();
    const rDoctor   = (rule.DoctorName  || '').trim();
    const rLocation = (rule.Location    || '').trim();
    const rDays     = (rule.DaysOfWeek  || '').split(',').map(d => d.trim()).filter(Boolean);
        const rType    = String(rule.RuleType || 'Deny').trim();
    if (
      (!rIntern   || rIntern   === internName)  &&
      (!rDoctor   || rDoctor   === doctorName)   &&
      (!rLocation || rLocation === location)     &&
      (rDays.length === 0 || rDays.includes(String(dayOfWeek)) ||
       rDays.some(d => d.toLowerCase() === dayName(dayOfWeek).toLowerCase()))
    ) {
      if (rType === 'Deny') return false;
    }
  }
  return true;
}

function buildSwitchMap(switches) {
  const map = {};
  for (const sw of switches) {
    const doctor = (sw.DoctorName || '').trim();
    if (!sw.SwitchDate || !doctor) continue;
    map[`${doctor}|${formatDate(new Date(sw.SwitchDate))}`] = {
      NewLocation:   sw.NewLocation   || sw.Location || '',
      NewDoctorName: sw.NewDoctorName || doctor
    };
  }
  return map;
}

function getDoctorsForDay(day, dateStr, doctorLocations, switchMap) {
  const dow     = day.getDay();
  const dayAbbr = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
  const result  = [];
  for (const dl of doctorLocations) {
    const activeDays = (dl.ActiveDays || '').split(',').map(d => d.trim()).filter(Boolean);
    const isActive   = activeDays.length === 0 ||
                       activeDays.some(d => d === dayAbbr || d === String(dow) || d.toLowerCase() === dayName(dow).toLowerCase());
    if (!isActive) continue;
    const doctorName = (dl.DoctorName || dl.Title || '').trim();
    const sw         = switchMap[`${doctorName}|${dateStr}`];
    result.push({
      DoctorName: sw ? (sw.NewDoctorName || doctorName) : doctorName,
      Location:   sw ? sw.NewLocation : (dl.Location || ''),
      MaxInterns: dl.MaxInterns || 1
    });
  }
  return result;
}

function getWeekdays(start, end) {
  const days = [];
  const d = new Date(start); d.setHours(0,0,0,0);
  const e = new Date(end);   e.setHours(23,59,59,999);
  while (d <= e) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function dayName(dow) {
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
}
