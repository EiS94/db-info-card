// DB Info Card - Custom Lovelace Card for Home Assistant
// Only works with DB Info Integration: https://github.com/EiS94/db_info

// Everything inserted into innerHTML goes through this
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The integration sends "Problems" as str(TrainProblem.X)
const PROBLEM_TEXTS = {
  DELAY: "Verspätung",
  CANCELED: "Fällt aus",
  STOP_NOT_APPLICABLE: "Halt entfällt",
  CHANGE_NOT_ACCESSIBLE: "Anschluss gefährdet",
};

// The integration sends "Details" as str(list) (Python repr, mostly single
// quotes, double quotes for strings containing an apostrophe). Convert that
// to JSON by re-encoding every string literal instead of blindly swapping quotes.
function pythonLiteralToJson(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      let str = "";
      i++;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\" && i + 1 < text.length) {
          const n = text[i + 1];
          if (n === "x" || n === "u" || n === "U") {
            const len = n === "x" ? 2 : n === "u" ? 4 : 8;
            str += String.fromCodePoint(parseInt(text.substr(i + 2, len), 16));
            i += 2 + len;
            continue;
          }
          str += { n: "\n", t: "\t", r: "\r" }[n] ?? n;
          i += 2;
          continue;
        }
        str += text[i++];
      }
      if (i >= text.length) throw new Error("Unterminated string");
      out += JSON.stringify(str);
      i++;
      continue;
    }
    const word = /^(None|True|False)\b/.exec(text.slice(i, i + 6));
    if (word && !/\w/.test(text[i - 1] || "")) {
      out += { None: "null", True: "true", False: "false" }[word[1]];
      i += word[1].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

class DbInfoCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    // Key (name + planned departure) of the expanded connection, so the
    // details stay with the connection when the list shifts
    this._expandedKey = null;
    this._lastStates = null;
    this.shadowRoot.addEventListener("click", (e) => {
      const row = e.target.closest(".main-row");
      if (row) this._toggle(row.getAttribute("data-key"));
    });
  }

  setConfig(config) {
    if (!config.entity_prefix) {
      throw new Error("Bitte 'entity_prefix' angeben, z.B. sensor.home_hbf_verbindung_");
    }
    // Optionale Spalten: show_start (default: true), show_problems (default: false), delay_threshold (default: 5), hide_city (default: "")
    // skin: "default" (table) or "db" (layout modelled on bahn.de)
    this._config = {
      skin: "default",
      show_start: true,
      show_problems: false,
      delay_threshold: 5,
      max_connections: 5,
      hide_city: "",
      ...config
    };
    this._lastStates = null;
    // goes through the hass setter, so the sensor snapshot matches the new prefix
    if (this._hass) this.hass = this._hass;
  }

  // hass is set on every state change in Home Assistant -> only re-render
  // when one of our own sensors changed (state objects are replaced on change)
  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const prefix = this._config.entity_prefix;
    const states = Object.keys(hass.states)
      .filter(id => id.startsWith(prefix))
      .map(id => hass.states[id]);
    const last = this._lastStates;
    if (last && last.length === states.length && states.every((s, i) => s === last[i])) return;
    this._lastStates = states;
    this._render();
  }

  _toggle(key) {
    this._expandedKey = this._expandedKey === key ? null : key;
    // Only toggle classes, so the CSS transition can run
    this.shadowRoot.querySelectorAll(".main-row").forEach(row => {
      const open = row.getAttribute("data-key") === this._expandedKey;
      row.querySelector(".expand-cell").textContent = open ? "▴" : "▾";
      row.nextElementSibling.querySelector(".detail-wrap").classList.toggle("wrap-open", open);
    });
  }

  _connectionKey(attr) {
    return `${attr.Name}|${attr["Departure Time"]}`;
  }

  _parseDetails(details) {
    if (typeof details === "string") {
      try {
        details = JSON.parse(details);
      } catch (e) {
        try {
          details = JSON.parse(pythonLiteralToJson(details));
        } catch (e2) {
          console.warn("db-info-card: Details konnten nicht gelesen werden", e2);
          details = [];
        }
      }
    }
    return Array.isArray(details) ? details : [];
  }

  _problem(raw) {
    if (!raw || raw === "null" || raw === "None") return null;
    const code = String(raw).replace(/^TrainProblem\./, "");
    return { code, text: PROBLEM_TEXTS[code] || String(raw) };
  }

  _icon(name) {
    if (!name) return "🚌";
    // search the whole name: the integration also sends e.g. "Regionalzug RE9"
    if (/\b(ICE|ECE|IC|EC|EN|NJ|RJX?|TGV|FLX)\s*\d|\b(ICE|TGV)\b|Fernzug|Intercity/.test(name)) return "🚄";
    if (/\bU\s*\d|U-Bahn/.test(name)) return "🚇";
    if (/\b(STR|Tram)\b|Straßenbahn|Stadtbahn/i.test(name)) return "🚊";
    if (/\b(RE|RB|IRE|MEX|S)\s*\d|\b(RE|RB|IRE|MEX)\b|S-Bahn|Regionalzug|Regionalexpress|Regionalbahn/.test(name)) return "🚆";
    if (/Fähre|\bF\s*\d/.test(name)) return "⛴️";
    return "🚌";
  }

  _delayClass(delay) {
    return delay >= this._config.delay_threshold ? "delay-late" : "delay-slight";
  }

  // The integration sends "2026-08-19T19:59:00+0200" (offset without colon),
  // which Safari/iOS can't parse -> normalize to "+02:00" first
  _parseDate(isoString) {
    if (!isoString) return null;
    const normalized = String(isoString).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? null : d;
  }

  _formatTime(isoString) {
    const d = this._parseDate(isoString);
    if (!d) return null;
    return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }

  _delayMinutes(planned, real) {
    const p = this._parseDate(planned);
    const r = this._parseDate(real);
    if (!p || !r) return 0;
    return Math.round((r - p) / 60000);
  }

  _renderTimeCell(planned, real, threshold) {
    const pt = this._formatTime(planned);
    const rt = this._formatTime(real);
    const delay = this._delayMinutes(planned, real);

    // No estimated data -> show nothing
    if (!pt) return `<span style="color:var(--secondary-text-color)">–</span>`;

    // no realtime data -> estimated data in default font color
    if (!rt) {
      return `<span>${pt}</span>`;
    }

    // realtime data available: check delay
    if (delay >= threshold) {
      return `<span style="display:block;color:grey;text-decoration:line-through;font-size:0.85em;line-height:1.3">${pt}</span><span style="display:block;color:red;line-height:1.3">${rt}</span>`;
    } else if (pt === rt) {
      return `<span style="color:green">${pt}</span>`;
    } else {
      return `<span style="display:block;color:grey;text-decoration:line-through;font-size:0.85em;line-height:1.3">${pt}</span><span style="display:block;color:green;line-height:1.3">${rt}</span>`;
    }
  }

  _getSensors() {
    const prefix = this._config.entity_prefix;
    const sensors = [];
    this._prefixFound = false;
    for (const entityId of Object.keys(this._hass.states)) {
      if (!entityId.startsWith(prefix)) continue;
      this._prefixFound = true;
      const sensor = this._hass.states[entityId];
      // Sensors without a connection (state "unknown", no attributes) are skipped
      if (!this._departureTimestamp(sensor)) continue;
      sensors.push(sensor);
    }
    // Comparator must never return NaN, otherwise the sort order is undefined
    // (an empty sensor used to push connection 1 to the end of the list)
    sensors.sort((a, b) =>
      (this._departureTimestamp(a) - this._departureTimestamp(b)) ||
      a.entity_id.localeCompare(b.entity_id, undefined, { numeric: true })
    );
    const max = Math.min(parseInt(this._config.max_connections) || 5, sensors.length);
    return sensors.slice(0, max);
  }

  _departureTimestamp(sensor) {
    const attr = sensor.attributes || {};
    const d = this._parseDate(attr["Departure Time Real"]) || this._parseDate(attr["Departure Time"]);
    return d ? d.getTime() : null;
  }

  _renderSegment(seg) {
    if (seg.Name === "Fußweg") {
      return `
        <tr class="segment-walk-row">
          <td colspan="4" class="segment-walk-cell">🚶 Fußweg</td>
        </tr>`;
    }

    const depDelay = this._delayMinutes(seg["Departure Time"], seg["Departure Time Real"]);

    const depBadge = depDelay > 0
      ? `<span class="delay-badge ${this._delayClass(depDelay)}">+${depDelay} Min</span>`
      : "";

    const platformDep = seg["Departure Platform"]
      ? `<span class="platform">Gl.&nbsp;${esc(seg["Departure Platform"])}</span>` : "";
    const platformArr = seg["Arrival Platform"]
      ? `<span class="platform">Gl.&nbsp;${esc(seg["Arrival Platform"])}</span>` : "";

    // Train destination as shown on the platform display (db_info >= PR 29).
    // Skipped when it is the stop where you get off anyway.
    const dir = String(seg["Departure Direction"] || "").trim();
    const sameAsArrival = dir.toLowerCase() === String(seg.Arrival || "").trim().toLowerCase();
    const direction = dir && !sameAsArrival
      ? ` <span class="segment-direction">→&nbsp;${esc(dir)}</span>` : "";

    return `
      <tr class="segment-header-row">
        <td colspan="4" class="segment-name-cell">
          ${this._icon(seg.Name)} <strong>${esc(seg.Name || "–")}</strong>${direction}${depBadge ? "&nbsp;" + depBadge : ""}
        </td>
      </tr>
      <tr class="segment-stop-row">
        <td class="stop-label">Ab</td>
        <td class="stop-name">${esc(seg.Departure || "–")}</td>
        <td class="stop-time">${this._renderTimeCell(seg["Departure Time"], seg["Departure Time Real"], this._config.delay_threshold)}</td>
        <td class="stop-platform">${platformDep}</td>
      </tr>
      <tr class="segment-stop-row">
        <td class="stop-label">An</td>
        <td class="stop-name">${esc(seg.Arrival || "–")}</td>
        <td class="stop-time">${this._renderTimeCell(seg["Arrival Time"], seg["Arrival Time Real"], this._config.delay_threshold)}</td>
        <td class="stop-platform">${platformArr}</td>
      </tr>`;
  }

  // hide_city accepts a comma-separated string ("Stuttgart, S-Feuerbach") or a YAML list
  _hideCities() {
    const raw = this._config.hide_city;
    const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
    return list
      .map(c => String(c).trim().replace(/[\s,\-–\/]+$/, ""))
      .filter(c => c)
      // longest first, so "Darmstadt-Wixhausen" wins over "Darmstadt"
      .sort((a, b) => b.length - a.length);
  }

  _formatStart(departure) {
    if (!departure) return "–";
    // separators between city and stop name: "Darmstadt-Wixhausen", "Würzburg Hbf",
    // "Letzter Hieb, Würzburg", "Hbf (Würzburg)"
    const sep = "[\\s,\\-–\\/]+";
    for (const city of this._hideCities()) {
      const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const result = departure
        .replace(new RegExp("^" + escaped + sep, "i"), "")
        .replace(new RegExp("(?:" + sep + escaped + "|\\s*\\(" + escaped + "\\))\\s*$", "i"), "")
        .trim();
      if (result && result !== departure) return result;
    }
    return departure;
  }

  // ---------------------------------------------------------------------
  // Skin "db": layout modelled on the connection list of bahn.de
  // ---------------------------------------------------------------------

  // Planned time, with the realtime value below it (green/red) if available
  _dbTime(planned, real, canceled) {
    const pt = this._formatTime(planned);
    if (!pt) return `<span class="db-t db-muted">–</span>`;
    if (canceled) return `<span class="db-t db-strike">${pt}</span>`;
    const rt = this._formatTime(real);
    if (!rt) return `<span class="db-t">${pt}</span>`;
    const late = this._delayMinutes(planned, real) >= this._config.delay_threshold;
    return `<span class="db-t">${pt}</span><span class="db-rt ${late ? "db-late" : "db-ontime"}">${rt}</span>`;
  }

  _segmentMinutes(seg) {
    const dep = this._parseDate(seg["Departure Time Real"]) || this._parseDate(seg["Departure Time"]);
    const arr = this._parseDate(seg["Arrival Time Real"]) || this._parseDate(seg["Arrival Time"]);
    if (!dep || !arr) return null;
    return Math.round((arr - dep) / 60000);
  }

  // Product class of a train name, used for the bahn.de colour coding.
  // Unknown names get no class and keep the neutral grey.
  _productClass(name) {
    if (!name) return "";
    if (/\b(ICE|ECE|TGV|RJX?|NJ|EN|FLX)\b|\b(ICE|ECE|TGV|RJX?|NJ|EN|FLX)\s*\d|Fernzug|Intercity-?Express/.test(name)) return "db-p-ice";
    if (/\b(IC|EC)\b|\b(IC|EC)\s*\d|Intercity|Eurocity/.test(name)) return "db-p-ic";
    if (/\bS\s*\d|S-Bahn/.test(name)) return "db-p-s";
    if (/\bU\s*\d|U-Bahn/.test(name)) return "db-p-u";
    if (/\b(STR|Tram)\b|Straßenbahn|Stadtbahn/i.test(name)) return "db-p-tram";
    if (/\b(RE|RB|IRE|MEX)\s*\d|\b(RE|RB|IRE|MEX)\b|Regionalzug|Regionalexpress|Regionalbahn/.test(name)) return "db-p-regio";
    if (/Fähre|Schiff|\bF\s*\d/.test(name)) return "db-p-ferry";
    if (/\b(AST|Taxi|Rufbus|Ruftaxi)\b/i.test(name)) return "db-p-taxi";
    if (/bus|\bSEV\b|^\s*\d+\s*$/i.test(name)) return "db-p-bus";
    return "";
  }

  // Bar with one block per leg, width proportional to its duration
  _dbProductBar(details) {
    const parts = details.map(seg => {
      if (seg.Name === "Fußweg") return `<span class="db-bar-walk" title="Fußweg">🚶</span>`;
      const grow = Math.max(this._segmentMinutes(seg) || 1, 1);
      return `<span class="db-bar-leg ${this._productClass(seg.Name)}" style="flex-grow:${grow}">${esc(seg.Name || "–")}</span>`;
    });
    return parts.length ? `<div class="db-bar">${parts.join("")}</div>` : "";
  }

  _dbPlatform(platform) {
    return platform ? `<span class="db-platform">Gl.&nbsp;${esc(platform)}</span>` : "";
  }

  _dbTrainRows(seg) {
    const dir = String(seg["Departure Direction"] || "").trim();
    const sameAsArrival = dir.toLowerCase() === String(seg.Arrival || "").trim().toLowerCase();
    const direction = dir && !sameAsArrival ? `<span class="db-direction">→&nbsp;${esc(dir)}</span>` : "";
    const mins = this._segmentMinutes(seg);
    const stop = (pos, name, planned, real, platform) => `
      <div class="db-row db-stop db-stop-${pos}">
        <div class="db-time">${this._dbTime(planned, real, false)}</div>
        <div class="db-rail"></div>
        <div class="db-station">${esc(name || "–")}</div>
        <div class="db-plat">${this._dbPlatform(platform)}</div>
      </div>`;
    return `
      ${stop("dep", seg.Departure, seg["Departure Time"], seg["Departure Time Real"], seg["Departure Platform"])}
      <div class="db-row db-leg">
        <div class="db-time">${mins > 0 ? `<span class="db-legdur">${mins}&nbsp;min</span>` : ""}</div>
        <div class="db-rail"></div>
        <div class="db-leginfo">
          <span class="db-chip ${this._productClass(seg.Name)}">${esc(seg.Name || "–")}</span>${direction}
        </div>
        <div class="db-plat"></div>
      </div>
      ${stop("arr", seg.Arrival, seg["Arrival Time"], seg["Arrival Time Real"], seg["Arrival Platform"])}`;
  }

  _dbTransferRow(prev, next, walk) {
    let mins = null;
    if (prev && next) {
      const arr = this._parseDate(prev["Arrival Time Real"]) || this._parseDate(prev["Arrival Time"]);
      const dep = this._parseDate(next["Departure Time Real"]) || this._parseDate(next["Departure Time"]);
      if (arr && dep && dep >= arr) mins = Math.round((dep - arr) / 60000);
    }
    const label = walk ? "🚶 Fußweg" : "Umstieg";
    return `
      <div class="db-row db-transfer">
        <div class="db-time"></div>
        <div class="db-rail"></div>
        <div class="db-transfer-text">${label}${mins !== null ? ` · ${mins}&nbsp;min Umstiegszeit` : ""}</div>
        <div class="db-plat"></div>
      </div>`;
  }

  _dbTimeline(details) {
    const out = [];
    let prev = null;
    let walk = false;
    for (const seg of details) {
      if (seg.Name === "Fußweg") { walk = true; continue; }
      if (prev || walk) out.push(this._dbTransferRow(prev, seg, walk));
      out.push(this._dbTrainRows(seg));
      prev = seg;
      walk = false;
    }
    if (walk) out.push(this._dbTransferRow(prev, null, true));
    return out.join("");
  }

  _renderDbSkin(sensors) {
    const title = this._config.title || "";

    const rowsHtml = sensors.map(sensor => {
      const attr = sensor.attributes;
      const key = this._connectionKey(attr);
      const isExpanded = this._expandedKey === key;
      const details = this._parseDetails(attr.Details || []);
      const problem = this._problem(attr.Problems);
      const canceled = !!problem && problem.code === "CANCELED";
      const firstTrain = details.find(seg => seg.Name !== "Fußweg");

      const transfers = attr.Transfers !== undefined && attr.Transfers !== null
        ? `${esc(attr.Transfers)}&nbsp;${Number(attr.Transfers) === 1 ? "Umstieg" : "Umstiege"}` : "";
      const meta = [attr.Duration ? esc(attr.Duration) : "", transfers].filter(Boolean).join(`<span class="db-sep">|</span>`);

      const start = this._config.show_start
        ? `<span class="db-start">${esc(this._formatStart(attr.Departure))}</span>${this._dbPlatform(firstTrain && firstTrain["Departure Platform"])}`
        : "";
      // a cancellation is always shown, other warnings only with show_problems
      const notice = problem && (canceled || this._config.show_problems)
        ? `<div class="db-notice${canceled ? " db-notice-error" : ""}">${esc(problem.text)}</div>` : "";
      const detailNotice = problem && !canceled && !this._config.show_problems
        ? `<div class="db-notice db-notice-detail">${esc(problem.text)}</div>` : "";

      return `
        <div class="db-conn${canceled ? " db-canceled" : ""}">
          <div class="main-row db-head" data-key="${esc(key)}">
            <div class="db-head-top">
              <div class="db-times">
                <span class="db-tcol">${this._dbTime(attr["Departure Time"], attr["Departure Time Real"], canceled)}</span>
                <span class="db-dash">–</span>
                <span class="db-tcol">${this._dbTime(attr["Arrival Time"], attr["Arrival Time Real"], canceled)}</span>
              </div>
              <div class="db-meta">${meta}</div>
            </div>
            ${this._dbProductBar(details)}
            ${notice}
            <div class="db-head-bottom">
              <div class="db-from">${start}</div>
              <div class="db-more">Details <span class="expand-cell">${isExpanded ? "▴" : "▾"}</span></div>
            </div>
          </div>
          <div class="db-detail">
            <div class="detail-wrap${isExpanded ? " wrap-open" : ""}">
              <div class="detail-inner">
                <div class="db-timeline">
                  ${detailNotice}
                  ${this._dbTimeline(details)}
                </div>
              </div>
            </div>
          </div>
        </div>`;
    }).join("");

    const emptyHtml = sensors.length === 0
      ? `<div class="db-empty">${this._emptyText()}</div>` : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }

        .db {
          --db-red: var(--db-info-red, #ec0016);
          --db-ontime: var(--db-info-ontime-color, #408335);
          --db-late: var(--db-info-late-color, #ec0016);
          --db-text: var(--primary-text-color, #282d37);
          --db-muted: var(--secondary-text-color, #646973);
          --db-line: var(--divider-color, #d7dce1);
          --db-fill: rgba(135, 140, 150, 0.22);
          --db-card: var(--ha-card-background, var(--card-background-color, #fff));
          color: var(--db-text);
          padding: 0 16px 4px 16px;
          line-height: 1.35;
        }
        .db-muted { color: var(--db-muted); }

        .db-conn { border-top: 1px solid var(--db-line); }
        .db-conn:first-child { border-top: none; }

        .db-head { padding: 12px 0 10px 0; cursor: pointer; }

        .db-head-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
        }
        .db-times { display: flex; align-items: flex-start; gap: 6px; }
        .db-tcol { display: flex; flex-direction: column; }
        .db-t { font-weight: 700; font-variant-numeric: tabular-nums; }
        .db-times .db-t, .db-dash { font-size: 1.25em; line-height: 1.2; }
        .db-dash { color: var(--db-text); }
        .db-rt { font-size: 0.85em; font-weight: 700; font-variant-numeric: tabular-nums; }
        .db-ontime { color: var(--db-ontime); }
        .db-late { color: var(--db-late); }
        .db-strike { text-decoration: line-through; color: var(--db-muted); }

        .db-meta {
          color: var(--db-muted);
          font-size: 0.9em;
          white-space: nowrap;
          padding-top: 0.25em;
        }
        .db-sep { margin: 0 0.5em; color: var(--db-line); }

        /* Product bar */
        .db-bar { display: flex; gap: 3px; margin-top: 10px; }
        .db-bar-leg {
          flex: 1 1 0;
          min-width: max-content;
          background: var(--db-fill);
          border-radius: 4px;
          padding: 3px 8px;
          font-size: 0.8em;
          font-weight: 700;
          text-align: center;
          white-space: nowrap;
        }
        .db-bar-walk {
          flex: 0 0 auto;
          padding: 3px 2px;
          font-size: 0.8em;
          border-bottom: 2px dotted var(--db-muted);
        }
        .db-canceled .db-bar-leg { text-decoration: line-through; opacity: 0.55; }

        /* Product colours as on bahn.de. The faint outline keeps the dark
           long-distance blocks visible on dark themes. */
        .db [class*="db-p-"] {
          background: var(--db-p);
          color: #fff;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
        }
        .db-p-ice   { --db-p: #282d37; }
        .db-p-ic    { --db-p: #646973; }
        .db-p-regio { --db-p: #878c96; }
        .db-p-s     { --db-p: #408335; }
        .db-p-u     { --db-p: #1455c0; }
        .db-p-tram  { --db-p: #a9455d; }
        .db-p-bus   { --db-p: #814997; }
        .db-p-ferry { --db-p: #309fd1; }
        .db .db-p-taxi { --db-p: #ffd800; color: #282d37; }

        .db-notice {
          margin-top: 8px;
          font-size: 0.85em;
          font-weight: 700;
          color: var(--warning-color, #c75f00);
        }
        .db-notice::before { content: "⚠ "; }
        .db-notice-error { color: var(--db-red); }
        .db-notice-detail { margin: 0 0 10px 0; }

        .db-head-bottom {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 12px;
          margin-top: 8px;
          font-size: 0.9em;
        }
        .db-from { color: var(--db-muted); min-width: 0; }
        .db-start { margin-right: 8px; }
        .db-more { color: var(--db-text); font-weight: 700; white-space: nowrap; }
        .db-head:hover .db-more { color: var(--db-red); }
        .expand-cell { font-size: 0.85em; }

        .db-platform { white-space: nowrap; color: var(--db-muted); }

        /* Detail expansion */
        .detail-wrap {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 0.25s ease;
        }
        .detail-wrap.wrap-open { grid-template-rows: 1fr; }
        .detail-inner { overflow: hidden; }

        /* Timeline */
        .db-timeline { padding: 4px 0 14px 0; font-size: 0.92em; }
        .db-row {
          display: grid;
          grid-template-columns: 3.3em 22px minmax(0, 1fr) auto;
          column-gap: 8px;
        }
        .db-time { display: flex; flex-direction: column; align-items: flex-end; }
        .db-station { font-weight: 700; }
        .db-plat { text-align: right; }

        .db-rail { position: relative; }
        .db-rail::before {
          content: "";
          position: absolute;
          left: 50%;
          top: 0;
          bottom: 0;
          width: 4px;
          margin-left: -2px;
          background: var(--db-text);
        }
        .db-stop .db-rail::after {
          content: "";
          position: absolute;
          left: 50%;
          top: 0.675em;
          width: 8px;
          height: 8px;
          margin: -7px 0 0 -7px;
          border: 3px solid var(--db-text);
          border-radius: 50%;
          background: var(--db-card);
        }
        .db-stop-dep .db-rail::before { top: 0.675em; }
        .db-stop-arr .db-rail::before { bottom: auto; height: 0.675em; }

        .db-leg { min-height: 2.6em; }
        .db-leginfo { align-self: center; padding: 8px 0; }
        .db-legdur { align-self: flex-end; margin: auto 0; color: var(--db-muted); font-size: 0.85em; }
        .db-chip {
          display: inline-block;
          background: var(--db-fill);
          border-radius: 4px;
          padding: 1px 8px;
          font-size: 0.88em;
          font-weight: 700;
          margin-right: 6px;
          white-space: nowrap;
        }
        .db-direction { color: var(--db-muted); }

        .db-transfer .db-rail::before {
          width: 0;
          margin-left: -2px;
          background: none;
          border-left: 4px dotted var(--db-muted);
        }
        .db-transfer-text { color: var(--db-muted); font-size: 0.9em; padding: 10px 0; }

        .db-empty { padding: 16px 0; text-align: center; color: var(--db-muted); }
      </style>

      <ha-card${title ? ` header="${esc(title)}"` : ""}>
        <div class="db">
          ${emptyHtml}
          ${rowsHtml}
        </div>
      </ha-card>
    `;
  }

  _emptyText() {
    return this._prefixFound
      ? "Aktuell keine Verbindungen verfügbar."
      : `Keine Sensoren gefunden für Prefix: <code>${esc(this._config.entity_prefix)}</code>`;
  }

  _render() {
    if (!this._hass || !this._config) return;

    const sensors = this._getSensors();
    if (this._config.skin === "db") return this._renderDbSkin(sensors);

    const title = this._config.title || "";
    const showStart = this._config.show_start;
    const threshold = this._config.delay_threshold;

    const rowsHtml = sensors.map((sensor, idx) => {
      const attr = sensor.attributes;
      const key = this._connectionKey(attr);
      const isExpanded = this._expandedKey === key;
      const isOdd = idx % 2 !== 0;

      const details = this._parseDetails(attr.Details || []);
      const problem = this._problem(attr.Problems);
      const canceled = problem && problem.code === "CANCELED";

      const depDelay = this._delayMinutes(attr["Departure Time"], attr["Departure Time Real"]);

      const segmentsHtml = details.map(seg => this._renderSegment(seg)).join("");

      const summaryHtml = `
        <tr class="detail-summary-row">
          <td colspan="4">
            <span class="summary-pill">⏱ ${esc(attr.Duration || "–")}</span>
            <span class="summary-pill">🔁 ${esc(attr.Transfers !== undefined ? attr.Transfers : "–")} ${Number(attr.Transfers) === 1 ? "Umstieg" : "Umstiege"}</span>
            ${depDelay > 0 ? `<span class="summary-pill ${this._delayClass(depDelay)}">+${depDelay} Min Verspätung</span>` : ""}
            ${problem ? `<span class="summary-pill problem-pill">⚠️ ${esc(problem.text)}</span>` : ""}
          </td>
        </tr>`;

      const bgStyle = isOdd
        ? "background-color:var(--table-row-alternative-background-color);"
        : "background-color:var(--table-row-background-color);";

      return `
        <tr class="main-row${canceled ? " canceled" : ""}" data-key="${esc(key)}" style="${bgStyle}cursor:pointer;">
          ${showStart ? `<td class="left">${esc(this._formatStart(attr.Departure))}</td>` : ""}
          <td class="left">
            <span class="conn-name">${esc(attr.Name || "–")}</span>
            ${problem && this._config.show_problems ? `<span class="problem-tag">${esc(problem.text)}</span>` : ""}
          </td>
          <td class="center time-cell">${this._renderTimeCell(attr["Departure Time"], attr["Departure Time Real"], threshold)}</td>
          <td class="center time-cell">${this._renderTimeCell(attr["Arrival Time"], attr["Arrival Time Real"], threshold)}</td>
          <td class="center expand-cell">${isExpanded ? "▴" : "▾"}</td>
        </tr>
        <tr class="detail-row" style="${bgStyle}">
          <td colspan="5" class="detail-td">
            <div class="detail-wrap${isExpanded ? " wrap-open" : ""}">
              <div class="detail-inner">
                <table class="detail-table">
                  <tbody>
                    ${summaryHtml}
                    <tr class="detail-divider"><td colspan="4"></td></tr>
                    ${segmentsHtml}
                  </tbody>
                </table>
              </div>
            </div>
          </td>
        </tr>`;
    }).join("");

    const emptyText = this._emptyText();
    const emptyHtml = sensors.length === 0
      ? `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--secondary-text-color)">
           ${emptyText}
         </td></tr>`
      : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }

        /* padding on a border-collapse table has no effect -> wrapper */
        .card-wrap { overflow: auto; padding: 8px; }

        table.main-table {
          width: 100%;
          border-collapse: collapse;
        }

        .main-row.canceled .conn-name {
          text-decoration: line-through;
          color: var(--error-color, red);
        }
        .problem-tag {
          display: block;
          font-size: 0.75em;
          color: var(--warning-color, orange);
        }
        .main-row.canceled .problem-tag { color: var(--error-color, red); }
        /* no green "on time" for a cancelled connection */
        .main-row.canceled .time-cell span {
          color: var(--secondary-text-color) !important;
          text-decoration: line-through;
        }

        thead th {
          height: 1em;
          padding-left: 0.5em;
          padding-right: 0.5em;
          text-align: left;
          color: var(--primary-text-color);
        }
        thead th.center { text-align: center; }

        tr td {
          padding: 0.5em;
          position: relative;
          overflow: hidden;
          color: var(--primary-text-color);
        }

        td.left   { text-align: left; }
        td.center { text-align: center; }

        .main-row:hover td { filter: brightness(1.06); }

        .expand-cell {
          color: var(--secondary-text-color);
          font-size: 0.85em;
          width: 1.5em;
        }

        /* Detail expansion */
        .detail-td { padding: 0 !important; }

        .detail-wrap {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 0.25s ease;
        }
        .detail-wrap.wrap-open {
          grid-template-rows: 1fr;
        }
        .detail-inner {
          overflow: hidden;
        }

        .detail-table {
          width: 100%;
          padding: 0 8px 8px 8px;
          border-collapse: collapse;
          border-top: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        }

        /* Summary */
        .detail-summary-row td { padding: 8px 0.5em 6px 0.5em; }

        .summary-pill {
          display: inline-block;
          background: var(--secondary-background-color, rgba(0,0,0,0.06));
          border-radius: 12px;
          padding: 2px 10px;
          font-size: 0.82em;
          margin-right: 5px;
          color: var(--primary-text-color);
        }
        .problem-pill { color: var(--warning-color, orange); }

        .detail-divider td {
          border-top: 1px solid var(--divider-color, rgba(0,0,0,0.08));
          padding: 0 !important;
        }

        /* Segments */
        .segment-header-row td,
        .segment-stop-row td,
        .segment-walk-row td {
          padding: 2px 0.5em;
          color: var(--primary-text-color);
          font-size: 0.9em;
        }
        .segment-name-cell { padding-top: 8px !important; }
        .segment-direction { color: var(--secondary-text-color); font-size: 0.9em; }

        .segment-walk-cell {
          color: var(--secondary-text-color);
          font-size: 0.85em !important;
          font-style: italic;
          padding: 4px 0.5em !important;
        }

        .stop-label {
          width: 2em;
          color: var(--secondary-text-color);
          font-size: 0.78em;
          font-weight: bold;
          text-transform: uppercase;
        }
        .stop-name  { color: var(--secondary-text-color); }
        .stop-time  { text-align: right; }
        .stop-platform { width: 4em; text-align: right; }

        .platform {
          background: var(--secondary-background-color, rgba(0,0,0,0.06));
          border-radius: 4px;
          padding: 1px 5px;
          font-size: 0.8em;
          white-space: nowrap;
        }

        .delay-badge {
          font-size: 0.75em;
          border-radius: 10px;
          padding: 1px 7px;
        }
        .delay-late   { background: rgba(244,67,54,0.12); color: red; }
        .delay-slight { background: rgba(76,175,80,0.12); color: green; }
      </style>

      <ha-card${title ? ` header="${esc(title)}"` : ""}>
        <div class="card-wrap">
          <table class="main-table">
            <thead>
              <tr>
                ${showStart ? '<th class="left">Start</th>' : ""}
                <th class="left">Verbindung</th>
                <th class="center" style="width:4.5em">Abfahrt</th>
                <th class="center" style="width:4.5em">Ankunft</th>
                <th style="width:1.5em"></th>
              </tr>
            </thead>
            <tbody>
              ${emptyHtml}
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </ha-card>
    `;
  }

  // 1 unit = ~50px: header + table head + one row per connection
  getCardSize() {
    const rows = parseInt(this._config?.max_connections) || 5;
    // the db skin has no table head, but each connection is about twice as tall
    if (this._config?.skin === "db") return (this._config?.title ? 1 : 0) + rows * 2;
    return (this._config?.title ? 1 : 0) + 1 + rows;
  }

  // Sections dashboard: full width by default, height grows with the details
  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  static getConfigElement() {
    return document.createElement("db-info-card-editor");
  }

  static getStubConfig() {
    return { entity_prefix: "", title: "", show_start: true, show_problems: false, delay_threshold: 5, max_connections: 5, hide_city: "" };
  }
}

customElements.define("db-info-card", DbInfoCard);


class DbInfoCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._initialized = false;
  }

  setConfig(config) {
    this._config = { show_start: true, show_problems: false, delay_threshold: 5, max_connections: 5, hide_city: "", ...config };
    if (this._initialized) {
      this._updateValues();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._buildDOM();
      this._initialized = true;
    } else {
      this._updateOptions();
    }
  }

  _hideCityText() {
    const raw = this._config.hide_city;
    return Array.isArray(raw) ? raw.join(", ") : (raw || "");
  }

  _getConnectionGroups() {
    if (!this._hass) return [];
    const groups = {};
    for (const [entityId, state] of Object.entries(this._hass.states)) {
      const match = entityId.match(/^(sensor\.(.+))_verbindung_\d+$/i);
      if (!match) continue;
      const prefix = match[1] + "_verbindung_";
      if (groups[prefix]) continue;
      const friendlyName = state.attributes.friendly_name || entityId;
      const label = friendlyName.replace(/\s*(verbindung|connection)\s*\d+\s*$/i, "").trim();
      groups[prefix] = label;
    }
    return Object.entries(groups).sort((a, b) => a[1].localeCompare(b[1]));
  }

  _buildDOM() {
    const groups = this._getConnectionGroups();
    const currentPrefix = this._config.entity_prefix || "";
    const showStart = this._config.show_start !== false;
    const showProblems = this._config.show_problems === true;
    const threshold = this._config.delay_threshold ?? 5;
    const title = this._config.title || "";
    const maxConn = this._config.max_connections ?? 5;
    const hideCity = this._hideCityText();

    const options = groups.map(([prefix, label]) =>
      `<option value="${esc(prefix)}" ${prefix === currentPrefix ? "selected" : ""}>${esc(label)}</option>`
    ).join("");

    this.shadowRoot.innerHTML = `
      <style>
        .editor { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
        label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--primary-text-color); }
        select, input[type="text"], input[type="number"] {
          padding: 8px;
          border-radius: 6px;
          border: 1px solid var(--divider-color, #ccc);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-size: 14px;
          width: 100%;
          box-sizing: border-box;
        }
        .row { display: flex; align-items: center; gap: 10px; }
        .row label { flex-direction: row; align-items: center; gap: 8px; cursor: pointer; }
        input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
        .hint { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
      </style>
      <div class="editor">
        <label>
          Verbindung
          <select id="prefix">
            <option value="">- Bitte wählen -</option>
            ${options}
          </select>
          <span class="hint">Nur Sensoren der DB Info Integration werden angezeigt</span>
        </label>

        <label>
          Kartentitel (optional)
          <input type="text" id="title" value="${esc(title)}" placeholder="z.B. Zuhause → Würzburg Hbf">
        </label>

        <label>
          Design
          <select id="skin">
            <option value="default" ${this._config.skin !== "db" ? "selected" : ""}>Standard (Tabelle)</option>
            <option value="db" ${this._config.skin === "db" ? "selected" : ""}>Deutsche Bahn (wie bahn.de)</option>
          </select>
        </label>

        <label>
          Verspätungsschwellwert (Minuten, ab dem Rot angezeigt wird)
          <input type="number" id="threshold" value="${threshold}" min="1" max="60">
        </label>

        <label>
          Anzahl angezeigter Verbindungen (1–5)
          <input type="number" id="max_connections" value="${maxConn}" min="1" max="5">
        </label>

        <label>
          Ortsnamen aus Start ausblenden (optional)
          <input type="text" id="hide_city" value="${esc(hideCity)}" placeholder="z.B. Stuttgart, S-Feuerbach">
          <span class="hint">Entfernt diese Ortsnamen aus der Start-Spalte, mehrere mit Komma trennen</span>
        </label>

        <div class="row">
          <label>
            <input type="checkbox" id="show_start" ${showStart ? "checked" : ""}>
            Start anzeigen
          </label>
        </div>

        <div class="row">
          <label>
            <input type="checkbox" id="show_problems" ${showProblems ? "checked" : ""}>
            Warnungen unter der Verbindung anzeigen (z.B. „Anschluss gefährdet“)
          </label>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById("prefix").addEventListener("change", (e) => {
      this._config = { ...this._config, entity_prefix: e.target.value };
      this._fireChange();
    });

    this.shadowRoot.getElementById("title").addEventListener("change", (e) => {
      this._config = { ...this._config, title: e.target.value };
      this._fireChange();
    });

    this.shadowRoot.getElementById("skin").addEventListener("change", (e) => {
      this._config = { ...this._config, skin: e.target.value };
      this._fireChange();
    });

    this.shadowRoot.getElementById("threshold").addEventListener("change", (e) => {
      this._config = { ...this._config, delay_threshold: parseInt(e.target.value) || 5 };
      this._fireChange();
    });

    this.shadowRoot.getElementById("max_connections").addEventListener("change", (e) => {
      const val = Math.min(5, Math.max(1, parseInt(e.target.value) || 5));
      this._config = { ...this._config, max_connections: val };
      this._fireChange();
    });

    this.shadowRoot.getElementById("show_start").addEventListener("change", (e) => {
      this._config = { ...this._config, show_start: e.target.checked };
      this._fireChange();
    });

    this.shadowRoot.getElementById("show_problems").addEventListener("change", (e) => {
      this._config = { ...this._config, show_problems: e.target.checked };
      this._fireChange();
    });

    this.shadowRoot.getElementById("hide_city").addEventListener("change", (e) => {
      this._config = { ...this._config, hide_city: e.target.value };
      this._fireChange();
    });
  }

  _updateValues() {
    const prefix = this.shadowRoot.getElementById("prefix");
    const title = this.shadowRoot.getElementById("title");
    const threshold = this.shadowRoot.getElementById("threshold");
    const maxConn = this.shadowRoot.getElementById("max_connections");
    const hideCity = this.shadowRoot.getElementById("hide_city");
    const showStart = this.shadowRoot.getElementById("show_start");
    if (!prefix) return;
    if (document.activeElement !== prefix) prefix.value = this._config.entity_prefix || "";
    if (document.activeElement !== title) title.value = this._config.title || "";
    if (document.activeElement !== threshold) threshold.value = this._config.delay_threshold ?? 5;
    if (document.activeElement !== maxConn) maxConn.value = this._config.max_connections ?? 5;
    if (hideCity && document.activeElement !== hideCity) hideCity.value = this._hideCityText();
    const skin = this.shadowRoot.getElementById("skin");
    if (skin && document.activeElement !== skin) skin.value = this._config.skin === "db" ? "db" : "default";
    showStart.checked = this._config.show_start !== false;
    this.shadowRoot.getElementById("show_problems").checked = this._config.show_problems === true;
  }

  _updateOptions() {
    const select = this.shadowRoot.getElementById("prefix");
    if (!select) return;
    if (select === this.shadowRoot.activeElement) return;
    const groups = this._getConnectionGroups();
    const currentValue = select.value;
    const existingValues = Array.from(select.options).map(o => o.value).filter(v => v);
    const newValues = groups.map(([p]) => p);
    const changed = existingValues.length !== newValues.length ||
      newValues.some(v => !existingValues.includes(v));
    if (!changed) return;
    const placeholder = select.options[0];
    select.innerHTML = "";
    select.appendChild(placeholder);
    groups.forEach(([prefix, label]) => {
      const opt = document.createElement("option");
      opt.value = prefix;
      opt.textContent = label;
      opt.selected = prefix === currentValue;
      select.appendChild(opt);
    });
  }

  _fireChange() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }
}

customElements.define("db-info-card-editor", DbInfoCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "db-info-card",
  name: "DB Info Card",
  description: "Deutsche Bahn Verbindungen mit ausklappbaren Details (DB Info Integration)",
});