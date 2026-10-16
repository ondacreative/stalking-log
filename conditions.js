// Conditions for the stalking log, worked out in the browser from Open-Meteo.
// Open-Meteo allows browser requests (CORS), so no server is needed.
//
// Past deer: the forecast API holds about 3 months back and is up to date;
// older dates use the archive API. Recent figures can be revised, so they are redone.
//
// The stalking rating scores each dawn and dusk from rules of thumb (RULES below).

const Conditions = (() => {
  const FRESH_DAYS = 10;           // newer data can still be revised
  const FORECAST_BACK_DAYS = 80;   // the forecast API covers about 92 days back
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const HOURLY = "temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,precipitation,snowfall," +
    "wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,visibility";

  // ---------- stalking rating rules
  // Each dawn is sunrise -1h to +2h. Each dusk is sunset -2h to +1h.
  const DAWN = [-1, 2], DUSK = [-2, 1];
  const POINTS = {
    "Steady breeze": 1,           // 5 to 20 km/h, holding direction: scent goes where you expect
    "Cold: deer feeding": 1,      // 3 °C or below
    "Clearing after rain": 1,     // over 2 mm in the 12h before, dry during
    "Fresh snow": 1,              // snow in the last 24h: deer easy to spot and track
    "Pressure rising": 1,         // up 3 hPa or more in 24h: settled weather
    "Calm: scent may swirl": -1,  // under 5 km/h
    "Wind shifting": -1,          // swings 90° or more during the outing
    "Warm: deer lie up": -1,      // 20 °C or above
    "Mist": -1,                   // visibility under 3 km
    "Full moon": -1,              // dawn only: deer may have fed all night
    "Too windy": -2,              // over 30 km/h, or gusts over 50: deer lie up, shots drift
    "Heavy rain": -2,             // over 3 mm during the outing
    "Fog": -2,                    // visibility under 1 km: hard to identify deer safely
  };
  const RULES = [
    ["Steady breeze", "wind 5 to 20 km/h, holding its direction"],
    ["Cold: deer feeding", "3 °C or colder"],
    ["Clearing after rain", "over 2 mm of rain in the 12 hours before, dry during"],
    ["Fresh snow", "snow in the last 24 hours"],
    ["Pressure rising", "up 3 hPa or more in 24 hours"],
    ["Calm: scent may swirl", "wind under 5 km/h"],
    ["Wind shifting", "wind swings round 90° or more"],
    ["Warm: deer lie up", "20 °C or warmer"],
    ["Mist", "visibility under 3 km"],
    ["Full moon", "dawn only, moon 85% or more"],
    ["Too windy", "wind over 30 km/h, or gusts over 50"],
    ["Heavy rain", "over 3 mm during the outing"],
    ["Fog", "visibility under 1 km"],
  ].map(([tag, when]) => ({ tag, when, points: POINTS[tag] }));
  const ratingOf = score => score >= 2 ? "Good" : score >= -1 ? "Fair" : "Poor";

  // ---------- small helpers
  const pad = n => String(n).padStart(2, "0");
  const round = (v, d = 0) => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 10 ** d) / 10 ** d;
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDay(d); };
  const sum = a => a.reduce((s, v) => s + v, 0);
  const mean = a => a.length ? sum(a) / a.length : NaN;
  const nums = a => a.filter(v => typeof v === "number" && isFinite(v));
  const qs = o => new URLSearchParams(o).toString();
  const hhmm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const angle = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  async function getJson(url, params) {
    const r = await fetch(`${url}?${qs(params)}`);
    if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
    return r.json();
  }

  function compass(deg) {
    if (deg === null || deg === undefined || !isFinite(deg)) return "";
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.floor((deg + 22.5) / 45) % 8];
  }
  function moon(iso) {
    const synodic = 29.530588853;
    const t = Date.UTC(...iso.split("-").map((v, i) => i === 1 ? v - 1 : +v), 12);
    const age = (((t - Date.UTC(2000, 0, 6, 18, 14)) / DAY) % synodic + synodic) % synodic;
    return [Math.round((1 - Math.cos(2 * Math.PI * age / synodic)) / 2 * 100), age < synodic / 2 ? "waxing" : "waning"];
  }
  function lightPhrase(when, sunrise, sunset) {
    const span = ms => { const m = Math.floor(Math.abs(ms) / 60e3); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
    if (when < sunrise) return `${span(sunrise - when)} before sunrise`;
    if (when > sunset) return `${span(when - sunset)} after sunset`;
    if (when - sunrise < sunset - when) return `${span(when - sunrise)} after sunrise`;
    return `${span(sunset - when)} before sunset`;
  }
  function visWord(m) {
    if (m === null || !isFinite(m)) return "";
    return m < 1000 ? "fog" : m < 3000 ? "mist" : m < 10000 ? "moderate" : "good";
  }

  // Open-Meteo hourly block -> rows sorted by time: [{ms, temp, rain, ...}]
  function hourRows(h) {
    return h.time.map((t, i) => ({
      t, ms: new Date(t).getTime(),
      temp: h.temperature_2m[i], feels: h.apparent_temperature[i], hum: h.relative_humidity_2m[i],
      pres: h.pressure_msl[i], rain: h.precipitation[i] || 0, snow: h.snowfall[i] || 0,
      wind: h.wind_speed_10m[i], dir: h.wind_direction_10m[i], gust: h.wind_gusts_10m[i],
      cloud: h.cloud_cover[i], vis: h.visibility[i],
    }));
  }
  const between = (rows, a, b) => rows.filter(r => r.ms >= a && r.ms < b);
  const nearest = (rows, t) => rows.reduce((best, r) => !best || Math.abs(r.ms - t) < Math.abs(best.ms - t) ? r : best, null);

  function weatherAt(rows, when) {
    // when: a local Date. Rain sums cover the hour itself and the hours before it.
    const hour = new Date(when); hour.setMinutes(0, 0, 0);
    const h = hour.getTime();
    const row = rows.find(r => r.ms === h), prev = rows.find(r => r.ms === h - DAY);
    const r = {};
    r.air_temp_c = row ? row.temp : null;
    r.feels_c = row ? row.feels : null;
    r.humidity_pct = row ? row.hum : null;
    r.pressure_hpa = row ? round(row.pres) : null;
    r.pressure_change_24h = row && prev ? round(row.pres - prev.pres, 1) : null;
    r.wind_kmh = row ? row.wind : null;
    r.gust_kmh = row ? row.gust : null;
    r.wind_from = row ? compass(row.dir) : "";
    r.cloud_pct = row ? row.cloud : null;
    r.visibility_m = row && typeof row.vis === "number" ? row.vis : null;
    r.rain_24h_mm = round(sum(between(rows, h - 23 * HOUR, h + HOUR).map(x => x.rain)), 1);
    r.snow_24h_cm = round(sum(between(rows, h - 23 * HOUR, h + HOUR).map(x => x.snow)), 1);
    return r;
  }

  // ---------- score one outing window against RULES
  function scoreWindow(rows, start, end, isDawn, moonPct) {
    const hs = between(rows, start - (start % HOUR), end);
    if (!hs.length) return null;
    const wind = mean(nums(hs.map(h => h.wind))), gust = Math.max(...nums(hs.map(h => h.gust)), 0);
    const dirs = nums(hs.map(h => h.dir));
    const shift = dirs.length ? Math.max(...dirs.map(d => angle(dirs[0], d))) : 0;
    const rain = sum(hs.map(h => h.rain));
    const rainBefore = sum(between(rows, start - 12 * HOUR, start).map(h => h.rain));
    const snow = sum(between(rows, end - DAY, end).map(h => h.snow));
    const temp = mean(nums(hs.map(h => h.temp)));
    const vis = nums(hs.map(h => h.vis));
    const minVis = vis.length ? Math.min(...vis) : null;
    const mid = hs[Math.floor(hs.length / 2)], before = nearest(rows, mid.ms - DAY);
    const presRise = before && Math.abs(before.ms - (mid.ms - DAY)) <= HOUR ? mid.pres - before.pres : null;

    const tags = [];
    if (wind > 30 || gust > 50) tags.push("Too windy");
    else if (wind < 5) tags.push("Calm: scent may swirl");
    else if (wind <= 20 && shift < 90) tags.push("Steady breeze");
    if (shift >= 90 && wind >= 5) tags.push("Wind shifting");
    if (rain > 3) tags.push("Heavy rain");
    else if (rainBefore > 2 && rain < 0.5) tags.push("Clearing after rain");
    if (temp <= 3) tags.push("Cold: deer feeding");
    else if (temp >= 20) tags.push("Warm: deer lie up");
    if (minVis !== null && minVis < 1000) tags.push("Fog");
    else if (minVis !== null && minVis < 3000) tags.push("Mist");
    if (snow >= 0.5) tags.push("Fresh snow");
    if (presRise !== null && presRise >= 3) tags.push("Pressure rising");
    if (isDawn && moonPct >= 85) tags.push("Full moon");

    const score = sum(tags.map(t => POINTS[t]));
    const mainDir = compass(dirs[Math.floor(dirs.length / 2)]);
    return {
      score, rating: ratingOf(score), reasons: tags,
      summary: `${mainDir} ${Math.round(wind)} km/h, ${Math.round(temp)} °C, ${rain >= 0.5 ? `${round(rain, 1)} mm rain` : "dry"}`,
    };
  }

  // ---------- conditions at a deer
  async function forCull(date, time, lat, lon) {
    if (typeof lat !== "number") throw new Error("No location");
    const when = new Date(`${date}T${time}`);
    const age = (Date.now() - new Date(date + "T12:00:00")) / DAY;
    const recent = age < FORECAST_BACK_DAYS;
    const wx = await getJson(recent ? "https://api.open-meteo.com/v1/forecast" : "https://archive-api.open-meteo.com/v1/archive", {
      latitude: lat.toFixed(3), longitude: lon.toFixed(3), start_date: addDays(date, -1), end_date: date,
      hourly: HOURLY, daily: "sunrise,sunset", timezone: "Europe/London",
    });
    const rows = hourRows(wx.hourly);
    const r = weatherAt(rows, when);
    const di = wx.daily.time.indexOf(date);
    const rise = new Date(wx.daily.sunrise[di]), set = new Date(wx.daily.sunset[di]);
    r.sunrise = wx.daily.sunrise[di].slice(11); r.sunset = wx.daily.sunset[di].slice(11);
    r.light = lightPhrase(when, rise, set);
    [r.moon_pct, r.moon_phase] = moon(date);
    // The rating for the hour either side of the deer, by the same rules as the forecast.
    const s = scoreWindow(rows, when.getTime() - HOUR, when.getTime() + HOUR, when < new Date((rise.getTime() + set.getTime()) / 2), r.moon_pct);
    if (s) { r.rating = s.rating; r.rating_reasons = s.reasons; }
    r.data_note = age < FRESH_DAYS ? "Recent: figures may be revised slightly" : "";
    r.added = isoDay(new Date());
    return r;
  }

  // ---------- right now, plus a rating for each dawn and dusk ahead
  async function now(lat, lon) {
    const body = await getJson("https://api.open-meteo.com/v1/forecast", {
      latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: "Europe/London",
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,visibility",
      hourly: HOURLY, daily: "sunrise,sunset", past_days: 1, forecast_days: 4,
    });
    const rows = hourRows(body.hourly);
    const c = body.current, nowMs = Date.now();
    const r = weatherAt(rows, new Date());
    // "current" is fresher than the hourly row, so prefer it
    Object.assign(r, {
      air_temp_c: c.temperature_2m, feels_c: c.apparent_temperature, humidity_pct: c.relative_humidity_2m,
      pressure_hpa: round(c.pressure_msl), cloud_pct: c.cloud_cover,
      wind_kmh: c.wind_speed_10m, gust_kmh: c.wind_gusts_10m, wind_from: compass(c.wind_direction_10m),
      visibility_m: typeof c.visibility === "number" ? c.visibility : r.visibility_m,
      raining: c.precipitation > 0,
    });
    const dayAgo = nearest(rows, nowMs - DAY);
    if (dayAgo && typeof c.pressure_msl === "number") r.pressure_change_24h = round(c.pressure_msl - dayAgo.pres, 1);
    r.rain_24h_mm = round(sum(between(rows, nowMs - DAY, nowMs).map(x => x.rain)), 1);
    r.rain_next6_mm = round(sum(between(rows, nowMs, nowMs + 6 * HOUR).map(x => x.rain)), 1);
    r.visibility = visWord(r.visibility_m);

    // Wind over the next few hours: does it swing round?
    r.wind_next = between(rows, nowMs, nowMs + 6 * HOUR + 1)
      .map(h => ({ at: h.t.slice(11), from: compass(h.dir), kmh: Math.round(h.wind) }));

    const today = isoDay(new Date());
    const days = body.daily.time.map((d, i) => ({ d, rise: new Date(body.daily.sunrise[i]), set: new Date(body.daily.sunset[i]), riseT: body.daily.sunrise[i], setT: body.daily.sunset[i] }));
    const t = days.find(x => x.d === today) || days[0];
    r.sunrise = t.riseT.slice(11); r.sunset = t.setT.slice(11);
    r.light = lightPhrase(new Date(), t.rise, t.set);
    const tomorrow = days.find(x => x.d === addDays(today, 1));
    r.sunrise_tomorrow = tomorrow ? tomorrow.riseT.slice(11) : "";
    [r.moon_pct, r.moon_phase] = moon(today);

    // Each dawn and dusk still to come, rated.
    const dayName = d => d === today ? "Today" : d === addDays(today, 1) ? "Tomorrow" : new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long" });
    r.outings = [];
    for (const x of days) {
      const mp = moon(x.d)[0];
      for (const [isDawn, base, [a, b]] of [[true, x.rise, DAWN], [false, x.set, DUSK]]) {
        const start = base.getTime() + a * HOUR, end = base.getTime() + b * HOUR;
        if (end <= nowMs) continue;
        const s = scoreWindow(rows, start, end, isDawn, mp);
        if (!s) continue;
        r.outings.push({ day: dayName(x.d), part: isDawn ? "dawn" : "dusk", from: hhmm(start), to: hhmm(end), ...s });
      }
    }
    r.outings = r.outings.slice(0, 6);
    r.updated = new Date().toISOString();
    return r;
  }

  return { forCull, now, FRESH_DAYS, RULES, ratingOf };
})();
