// Conditions for the stalking log, worked out in the browser from Open-Meteo.
// Open-Meteo allows browser requests (CORS), so no server is needed.
//
// Past deer: the forecast API holds about 3 months back and is up to date;
// older dates use the archive API. Recent figures can be revised, so they are redone.

const Conditions = (() => {
  const FRESH_DAYS = 10;           // newer data can still be revised
  const FORECAST_BACK_DAYS = 80;   // the forecast API covers about 92 days back
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const HOURLY = "temperature_2m,pressure_msl,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover";

  // ---------- small helpers
  const pad = n => String(n).padStart(2, "0");
  const round = (v, d = 0) => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 10 ** d) / 10 ** d;
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDay(d); };
  const sum = a => a.reduce((s, v) => s + v, 0);
  const qs = o => new URLSearchParams(o).toString();

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
  // Open-Meteo hourly block -> {"2026-10-02T09:00": {col: value}}
  function hourlyMap(h) {
    const out = {};
    h.time.forEach((t, i) => { out[t] = {}; for (const k of Object.keys(h)) if (k !== "time") out[t][k] = h[k][i]; });
    return out;
  }
  const hourKey = d => `${isoDay(d)}T${pad(d.getHours())}:00`;

  function weatherAt(hourly, when) {
    // when: a local Date. Rain sums cover the hour itself and the hours before it.
    const r = {};
    const hour = new Date(when); hour.setMinutes(0, 0, 0);
    const row = hourly[hourKey(hour)];
    const prev = hourly[hourKey(new Date(hour.getTime() - DAY))];
    r.air_temp_c = row ? row.temperature_2m : null;
    r.pressure_hpa = row ? round(row.pressure_msl) : null;
    r.pressure_change_24h = row && prev ? round(row.pressure_msl - prev.pressure_msl, 1) : null;
    r.wind_kmh = row ? row.wind_speed_10m : null;
    r.gust_kmh = row ? row.wind_gusts_10m : null;
    r.wind_from = row ? compass(row.wind_direction_10m) : "";
    r.cloud_pct = row ? row.cloud_cover : null;
    const rain = hours => round(sum(Array.from({ length: hours }, (_, i) =>
      (hourly[hourKey(new Date(hour.getTime() - i * HOUR))] || {}).precipitation || 0)), 1);
    r.rain_24h_mm = rain(24);
    return r;
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
    const r = weatherAt(hourlyMap(wx.hourly), when);
    const di = wx.daily.time.indexOf(date);
    r.sunrise = wx.daily.sunrise[di].slice(11); r.sunset = wx.daily.sunset[di].slice(11);
    r.light = lightPhrase(when, new Date(wx.daily.sunrise[di]), new Date(wx.daily.sunset[di]));
    [r.moon_pct, r.moon_phase] = moon(date);
    r.data_note = age < FRESH_DAYS ? "Recent: figures may be revised slightly" : "";
    r.added = isoDay(new Date());
    return r;
  }

  // ---------- right now, at a place
  async function now(lat, lon) {
    const body = await getJson("https://api.open-meteo.com/v1/forecast", {
      latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: "Europe/London",
      current: "temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation",
      hourly: "wind_speed_10m,wind_direction_10m", daily: "sunrise,sunset", forecast_days: 2,
    });
    const c = body.current;
    const r = {
      air_temp_c: c.temperature_2m, pressure_hpa: round(c.pressure_msl), cloud_pct: c.cloud_cover,
      wind_kmh: c.wind_speed_10m, gust_kmh: c.wind_gusts_10m, wind_from: compass(c.wind_direction_10m),
      raining: c.precipitation > 0,
    };
    // Wind over the next few hours: does it swing round?
    const nowMs = Date.now();
    r.wind_next = body.hourly.time.map((t, i) => ({ t, ms: new Date(t).getTime(), from: compass(body.hourly.wind_direction_10m[i]), kmh: body.hourly.wind_speed_10m[i] }))
      .filter(h => h.ms > nowMs && h.ms <= nowMs + 6 * HOUR)
      .map(h => ({ at: h.t.slice(11), from: h.from, kmh: Math.round(h.kmh) }));
    const today = isoDay(new Date());
    const days = body.daily.time.map((d, i) => ({ d, rise: body.daily.sunrise[i], set: body.daily.sunset[i] }));
    const t = days.find(x => x.d === today) || days[0];
    r.sunrise = t.rise.slice(11); r.sunset = t.set.slice(11);
    r.light = lightPhrase(new Date(), new Date(t.rise), new Date(t.set));
    const tomorrow = days.find(x => x.d === addDays(today, 1));
    r.sunrise_tomorrow = tomorrow ? tomorrow.rise.slice(11) : "";
    [r.moon_pct, r.moon_phase] = moon(today);
    r.updated = new Date().toISOString();
    return r;
  }

  return { forCull, now, FRESH_DAYS };
})();
