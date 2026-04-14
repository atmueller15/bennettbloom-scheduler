// Bennett & Bloom Intern + Resident Scheduler
// POST /api/generateSchedule
// Body: { startDate, endDate, interns, doctorLocations, blackouts, assignmentRules,
//         timeOff, clinicSwitches, residentSchedule, residentSwitches }
// Header: x-api-secret: <API_SECRET>

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const providedSecret = req.headers['x-api-secret'];
  const expectedSecret = process.env.API_SECRET;
  if (!expectedSecret || providedSecret !== expectedSecret)
    return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body;
  if (!body) return res.status(400).json({ error: 'Empty body' });

  const { startDate, endDate } = body;
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required' });

  function unwrap(input) {
    let arr = Array.isArray(input) ? input : (input && Array.isArray(input.value) ? input.value : []);
    return arr.map(item => {
      const out = {};
      for (const [key, val] of Object.entries(item)) {
        if (['@odata.etag','ItemInternalId','ID','Modified','Created','Author','Editor'].includes(key) || key.startsWith('@odata')) continue;
        out[key.replace(/_x0020_/g, '')] = val;
      }
      return out;
    });
  }

  const interns          = unwrap(body.interns);
  const doctorLocations  = unwrap(body.doctorLocations);
  const blackouts        = unwrap(body.blackouts);
  const assignmentRules  = unwrap(body.assignmentRules);
  const timeOff          = unwrap(body.timeOff);
  const clinicSwitches   = unwrap(body.clinicSwitches);
  const residentSchedule = unwrap(body.residentSchedule  || []);
  const residentSwitches = unwrap(body.residentSwitches  || []);

  try {
    const schedule = generateSchedule({
      startDate: new Date(startDate),
      endDate:   new Date(endDate),
      interns, doctorLocations, blackouts, assignmentRules,
      timeOff, clinicSwitches, residentSchedule, residentSwitches
    });
    return res.status(200).json({ success: true, totalAssignments: schedule.length, schedule });
  } catch (err) {
    console.error('Scheduling error:', err);
    return res.status(500).json({ error: 'Scheduling failed', detail: err.message });
  }
}

const INITIALS_TO_NAME = {
  AM:  'Adam Mueller',
  AP:  'Alexandra Pasley',
  AS:  'Andrew Steele',
  AE:  'Austin Eckel',
  FM:  'Fraser McKay',
  IM:  'Ian McWherter',
  IS:  'Inder Singal',
  JA:  'Janelle Adeniran',
  KS:  'Keith Slayden',
  LT:  'Lawrence Tenkman',
  MA:  'Mattie Adams',
  MLM: 'Meredith Mueller',
  MWM: 'Matthew Meredith',
  NZ:  'Nikolaos Zagorianos',
  SB:  'Steven Bloom',
  WG:  'William Gibson',
};

const W1_REF = new Date('2025-01-06T00:00:00Z');
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

function getMondayOf(date) {
  const d = new Date(date);
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
}

function getWeekInfo(date) {
  const monday = getMondayOf(date);
  const weeksSince = Math.round((monday - W1_REF) / MS_PER_WEEK);
  const weekNum = ((weeksSince % 5) + 5) % 5 + 1;
  return { weekNum, isOdd: weekNum % 2 === 1 };
}

function weekTypeMatches(weekType, isOdd) {
  if (!weekType || weekType === 'All') return true;
  const lower = weekType.toLowerCase();
  if (lower.includes('odd'))  return isOdd;
  if (lower.includes('even')) return !isOdd;
  return true;
}

function generateSchedule({ startDate, endDate, interns, doctorLocations, blackouts,
                             assignmentRules, timeOff, clinicSwitches,
                             residentSchedule, residentSwitches }) {
  const assignments    = [];
  const blackoutMap    = buildBlackoutMap(blackouts);
  const timeOffMap     = buildTimeOffMap(timeOff);
  const switchMap      = buildSwitchMap(clinicSwitches);
  const resSwitchMap   = buildResidentSwitchMap(residentSwitches);
  const internLocCount = {};
  interns.forEach(i => { internLocCount[i.Title] = {}; });

  for (const day of getWeekdays(startDate, endDate)) {
    const dateStr      = formatDate(day);
    const doctorsToday = getDoctorsForDay(day, dateStr, doctorLocations, switchMap);
    if (doctorsToday.length === 0) continue;

    const { isOdd } = getWeekInfo(day);
    const dayName    = DAY_NAMES[day.getDay()];

    const { residentAssigns, occupiedDoctors } = assignResidents(
      dateStr, dayName, isOdd, residentSchedule, resSwitchMap
    );
    assignments.push(...residentAssigns);

    const available   = interns.filter(i => !isOnTimeOff(i.Title, dateStr, timeOffMap));
    if (available.length === 0) continue;

    const openDoctors = doctorsToday.filter(d => !occupiedDoctors.has(d.DoctorName));

    assignments.push(...assignInternsToLocations({
      date: dateStr, dayOfWeek: day.getDay(), doctors: openDoctors,
      interns: available, blackoutMap, rulesMap: assignmentRules, internLocCount
    }));
  }
  return assignments;
}

function assignResidents(dateStr, dayName, isOdd, residentSchedule, resSwitchMap) {
  const residentAssigns = [];
  const occupiedDoctors = new Set();

  const dayEntries = residentSchedule.filter(r =>
    r.DayOfWeek === dayName && weekTypeMatches(r.WeekType, isOdd)
  );

  for (const entry of dayEntries) {
    const swKey = `${entry.ResidentName}|${dateStr}|${entry.Session}`;
    const sw    = resSwitchMap[swKey];
    const doctorInitials = (sw ? sw.NewDoctorInitials : entry.DoctorInitials) || '';
    const clinic         = (sw ? sw.NewClinic         : entry.Clinic)         || '';
    const doctorName     = INITIALS_TO_NAME[doctorInitials] || doctorInitials;

    residentAssigns.push({
      Date: dateStr, Session: entry.Session, InternName: entry.ResidentName,
      PersonType: 'Resident', DoctorName: doctorName, DoctorInitials: doctorInitials,
      Location: clinic, Status: sw ? 'Override' : 'Assigned',
    });
    occupiedDoctors.add(doctorName);
  }
  return { residentAssigns, occupiedDoctors };
}

function assignInternsToLocations({ date, dayOfWeek, doctors, interns,
                                    blackoutMap, rulesMap, internLocCount }) {
  const results = []; const assignedToday = new Set();
  for (const slot of [...doctors].sort((a, b) => (a.Location||'').localeCompare(b.Location||''))) {
    const { DoctorName, Location, MaxInterns = 1 } = slot;
    const slotsNeeded = parseInt(MaxInterns, 10) || 1; let filled = 0;
    const candidates = interns
      .filter(i => !assignedToday.has(i.Title) && !isBlackedOut(i.Title, DoctorName, date, blackoutMap) &&
                   meetsRules(i.Title, DoctorName, Location, dayOfWeek, rulesMap))
      .map(i => ({ intern: i, score: (internLocCount[i.Title]||{})[Location]||0 }))
      .sort((a, b) => a.score - b.score);
    for (const { intern } of candidates) {
      if (filled >= slotsNeeded) break;
      results.push({ Date: date, Session: 'AllDay', InternName: intern.Title,
                     PersonType: 'Intern', DoctorName, Location, Status: 'Assigned' });
      internLocCount[intern.Title][Location] = (internLocCount[intern.Title][Location]||0)+1;
      assignedToday.add(intern.Title); filled++;
    }
    for (let i = filled; i < slotsNeeded; i++)
      results.push({ Date: date, Session: 'AllDay', InternName: 'UNASSIGNED',
                     PersonType: 'Intern', DoctorName, Location, Status: 'Unassigned' });
  }
  return results;
}

function buildBlackoutMap(blackouts) {
  const map = {};
  for (const b of blackouts) {
    const intern = (b.InternName||'').trim(); const doctor = (b.DoctorName||'').trim();
    if (!intern || !doctor) continue;
    if (b.BlackoutDate) map[`${intern}|${doctor}|${formatDate(new Date(b.BlackoutDate))}`] = true;
    else map[`${intern}|${doctor}`] = true;
  }
  return map;
}

function buildTimeOffMap(timeOff) {
  const map = {};
  for (const t of timeOff) {
    if (t.Status === 'Denied') continue;
    const intern = (t.InternName||'').trim();
    const start = new Date(t.StartDate); const end = new Date(t.EndDate || t.StartDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1))
      map[`${intern}|${formatDate(new Date(d))}`] = true;
  }
  return map;
}

function buildSwitchMap(switches) {
  const map = {};
  for (const sw of switches) {
    const doctor = (sw.DoctorName||'').trim();
    if (!sw.SwitchDate || !doctor) continue;
    map[`${doctor}|${formatDate(new Date(sw.SwitchDate))}`] = {
      NewLocation: sw.NewLocation || sw.Location || '', NewDoctorName: sw.NewDoctorName || doctor,
    };
  }
  return map;
}

function buildResidentSwitchMap(switches) {
  const map = {};
  for (const sw of switches) {
    const resident = (sw.ResidentName||'').trim();
    const dateStr = sw.SwitchDate ? formatDate(new Date(sw.SwitchDate)) : '';
    if (!resident || !dateStr) continue;
    const sessions = (sw.Session === 'Both') ? ['AM','PM'] : [sw.Session];
    for (const session of sessions) map[`${resident}|${dateStr}|${session}`] = sw;
  }
  return map;
}

function getDoctorsForDay(day, dateStr, doctorLocations, switchMap) {
  const dow = day.getDay();
  const dayAbbr = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
  const result = [];
  for (const dl of doctorLocations) {
    const activeDays = (dl.ActiveDays||'').split(',').map(d => d.trim()).filter(Boolean);
    const isActive = activeDays.length === 0 ||
      activeDays.some(d => d === dayAbbr || d === String(dow) ||
                           d.toLowerCase() === DAY_NAMES[dow].toLowerCase());
    if (!isActive) continue;
    const doctorName = (dl.DoctorName || dl.Title || '').trim();
    const sw = switchMap[`${doctorName}|${dateStr}`];
    result.push({ DoctorName: sw ? (sw.NewDoctorName||doctorName) : doctorName,
                  Location: sw ? sw.NewLocation : (dl.Location||''), MaxInterns: dl.MaxInterns||1 });
  }
  return result;
}

function isBlackedOut(internName, doctorName, dateStr, map) {
  return !!(map[`${internName}|${doctorName}|${dateStr}`] || map[`${internName}|${doctorName}`]);
}
function isOnTimeOff(internName, dateStr, map) { return !!map[`${internName}|${dateStr}`]; }
function meetsRules(internName, doctorName, location, dayOfWeek, rules) {
  for (const rule of rules) {
    const rIntern = (rule.InternName||'').trim(); const rDoctor = (rule.DoctorName||'').trim();
    const rLocation = (rule.Location||'').trim();
    const rDays = (rule.DaysOfWeek||'').split(',').map(d => d.trim()).filter(Boolean);
    const rType = String(rule.RuleType||'Deny').trim();
    if ((!rIntern || rIntern === internName) && (!rDoctor || rDoctor === doctorName) &&
        (!rLocation || rLocation === location) &&
        (rDays.length === 0 || rDays.includes(String(dayOfWeek)) ||
         rDays.some(d => d.toLowerCase() === DAY_NAMES[dayOfWeek].toLowerCase())))
      if (rType === 'Deny') return false;
  }
  return true;
}

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function getWeekdays(start, end) {
  const days = []; const d = new Date(start); d.setHours(0,0,0,0);
  const e = new Date(end); e.setHours(23,59,59,999);
  while (d <= e) { if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d)); d.setDate(d.getDate()+1); }
  return days;
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
