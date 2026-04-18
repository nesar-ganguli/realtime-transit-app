#!/usr/bin/env node
/**
 * fetchStopTimes.js  —  run ONCE, do not commit the zip, only commit the output.
 *
 * Steps:
 *   1. npm install --save-dev adm-zip          (only you need to do this)
 *   2. node scripts/fetchStopTimes.js
 *   3. Commit src/generated/stopSchedule.js
 *
 * Teammates never need to run this. The generated file is checked in.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const GTFS_URL  = 'https://s3.amazonaws.com/etatransit.gtfs/bloomingtontransit.etaspot.net/gtfs.zip';
const TMP_ZIP   = path.join(__dirname, '_gtfs_tmp.zip');
const OUTPUT    = path.join(__dirname, '..', 'src', 'generated', 'stopSchedule.js');

let AdmZip;
try {
  AdmZip = require('adm-zip');
} catch {
  console.error('\n  Missing adm-zip. Please run:\n\n    npm install --save-dev adm-zip\n');
  process.exit(1);
}

function download(url, dest, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.destroy();
        fs.unlink(dest, () => {});
        return download(res.headers.location, dest, redirects + 1)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        process.stdout.write(`\r  Downloading... ${(received / 1024 / 1024).toFixed(1)} MB`);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); console.log(''); resolve(); });
    }).on('error', (e) => {
      fs.unlink(dest, () => {});
      reject(e);
    });
  });
}

function parseCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^\uFEFF/, ''));
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const obj = {};
    headers.forEach((h, j) => { obj[h] = (vals[j] || '').trim(); });
    out.push(obj);
  }
  return out;
}

function normalizeTime(t) {
  if (!t) return null;
  const parts = t.split(':');
  const h = parseInt(parts[0], 10) % 24;
  const m = parts[1] ? parts[1].padStart(2, '0') : '00';
  return `${String(h).padStart(2, '0')}:${m}`;
}

async function main() {
  console.log('Bloomington Transit GTFS Stop Times Generator');
  console.log('----------------------------------------------');
  console.log('Downloading GTFS zip from S3...');

  await download(GTFS_URL, TMP_ZIP);
  console.log('Unzipping and parsing...');

  const zip = new AdmZip(TMP_ZIP);

  const readFile = (name) => {
    try { return zip.readAsText(name); }
    catch { return ''; }
  };

  const tripsRows        = parseCSV(readFile('trips.txt'));
  const stopTimesRows    = parseCSV(readFile('stop_times.txt'));
  const calendarRows     = parseCSV(readFile('calendar.txt'));
  const calDatesRows     = parseCSV(readFile('calendar_dates.txt'));

  console.log(`  trips:         ${tripsRows.length}`);
  console.log(`  stop_times:    ${stopTimesRows.length}`);
  console.log(`  calendar:      ${calendarRows.length}`);
  console.log(`  calendar_dates:${calDatesRows.length}`);

  // trip_id -> { routeId, serviceId }
  const tripMap = {};
  for (const t of tripsRows) {
    tripMap[t.trip_id] = { routeId: t.route_id, serviceId: t.service_id };
  }

  // serviceCalendar
  const serviceCalendar = {};
  for (const c of calendarRows) {
    serviceCalendar[c.service_id] = {
      monday:    parseInt(c.monday,    10),
      tuesday:   parseInt(c.tuesday,   10),
      wednesday: parseInt(c.wednesday, 10),
      thursday:  parseInt(c.thursday,  10),
      friday:    parseInt(c.friday,    10),
      saturday:  parseInt(c.saturday,  10),
      sunday:    parseInt(c.sunday,    10),
      startDate: c.start_date,
      endDate:   c.end_date,
    };
  }

  // calendarExceptions { dateStr: { serviceId: exceptionType } }
  const calendarExceptions = {};
  for (const e of calDatesRows) {
    if (!calendarExceptions[e.date]) calendarExceptions[e.date] = {};
    calendarExceptions[e.date][e.service_id] = parseInt(e.exception_type, 10);
  }

  // stopSchedule { stopId: [{ routeId, serviceId, arrivalTime }] }
  const stopSchedule = {};
  let skipped = 0;
  let processed = 0;

  for (const st of stopTimesRows) {
    const trip = tripMap[st.trip_id];
    if (!trip) { skipped++; continue; }
    const time = normalizeTime(st.arrival_time || st.departure_time);
    if (!time) { skipped++; continue; }

    if (!stopSchedule[st.stop_id]) stopSchedule[st.stop_id] = [];
    stopSchedule[st.stop_id].push({
      r: trip.routeId,
      s: trip.serviceId,
      t: time,
    });
    processed++;
  }

  // Sort each stop's entries by time
  for (const arr of Object.values(stopSchedule)) {
    arr.sort((a, b) => a.t.localeCompare(b.t));
  }

  const stopCount = Object.keys(stopSchedule).length;
  console.log(`\n  Processed: ${processed} arrivals across ${stopCount} stops`);
  if (skipped > 0) console.log(`  Skipped:   ${skipped} (unknown trip_id)`);

  const outputContent = `// Auto-generated by scripts/fetchStopTimes.js
// Re-run that script to update. Do not edit manually.
// Keys in stopSchedule entries: r=routeId, s=serviceId, t=arrivalTime (HH:MM 24h)

export const stopSchedule = ${JSON.stringify(stopSchedule)};

export const serviceCalendar = ${JSON.stringify(serviceCalendar, null, 2)};

export const calendarExceptions = ${JSON.stringify(calendarExceptions)};
`;

  fs.writeFileSync(OUTPUT, outputContent, 'utf8');
  fs.unlinkSync(TMP_ZIP);

  const sizeKB = Math.round(fs.statSync(OUTPUT).size / 1024);
  console.log(`\nDone. Written to: src/generated/stopSchedule.js (${sizeKB} KB)`);
  console.log('You can now commit this file. Your teammates do not need to run this script.\n');
}

main().catch((e) => { console.error('\nError:', e.message); process.exit(1); });
