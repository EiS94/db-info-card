// DB Info Card - Custom Lovelace Card for Home Assistant
// Only works with DB Info Integration: https://github.com/EiS94/db_info

class DbInfoCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._expandedRow = null;
  }

  setConfig(config) {
    if (!config.entity_prefix) {
      throw new Error("Bitte 'entity_prefix' angeben, z.B. sensor.home_hbf_verbindung_");
    }

    this._config = {
      show_start: true,
      delay_threshold: 5,
      hide_city: "",
      ...config
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _formatTime(isoString) {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }

  _delayMinutes(planned, real) {
    if (!planned || !real) return 0;
    const p = new Date(planned);
    const r = new Date(real);
    if (isNaN(p.getTime()) || isNaN(r.getTime())) return 0;
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
    for (const entityId of Object.keys(this._hass.states)) {
      if (entityId.startsWith(prefix)) {
        sensors.push(this._hass.states[entityId]);
      }
    }
    sensors.sort((a, b) => {
      const ta = a.attributes["Departure Time Real"] || a.attributes["Departure Time"] || "";
      const tb = b.attributes["Departure Time Real"] || b.attributes["Departure Time"] || "";
      return new Date(ta) - new Date(tb);
    });
    return sensors;
  }

  _renderSegment(seg) {
    if (seg.Name === "Fußweg") {
      return `
        <tr class="segment-walk-row">
          <td colspan="4" class="segment-walk-cell">🚶 Fußweg</td>
        </tr>`;
    }

    const depDelay = this._delayMinutes(seg["Departure Time"], seg["Departure Time Real"]);

    const isICE = seg.Name && /^(ICE|IC |EC )/.test(seg.Name);
    const isRail = seg.Name && /^(RE|RB|S\d|IRE)/.test(seg.Name);
    let icon = "🚌";
    if (isICE) icon = "🚄";
    else if (isRail) icon = "🚆";

    const depBadge = depDelay > 4
      ? `<span class="delay-badge delay-late">+${depDelay} Min</span>`
      : depDelay > 0
      ? `<span class="delay-badge delay-slight">+${depDelay} Min</span>`
      : "";

    const platformDep = seg["Departure Platform"]
      ? `<span class="platform">Gl.&nbsp;${seg["Departure Platform"]}</span>` : "";
    const platformArr = seg["Arrival Platform"]
      ? `<span class="platform">Gl.&nbsp;${seg["Arrival Platform"]}</span>` : "";

    return `
      <tr class="segment-header-row">
        <td colspan="4" class="segment-name-cell">
          ${icon} <strong>${seg.Name || "–"}</strong>${depBadge ? "&nbsp;" + depBadge : ""}
        </td>
      </tr>
      <tr class="segment-stop-row">
        <td class="stop-label">Ab</td>
        <td class="stop-name">${seg.Departure || "–"}</td>
        <td class="stop-time">${this._renderTimeCell(seg["Departure Time"], seg["Departure Time Real"], this._config.delay_threshold)}</td>
        <td class="stop-platform">${platformDep}</td>
      </tr>
      <tr class="segment-stop-row">
        <td class="stop-label">An</td>
        <td class="stop-name">${seg.Arrival || "–"}</td>
        <td class="stop-time">${this._renderTimeCell(seg["Arrival Time"], seg["Arrival Time Real"], this._config.delay_threshold)}</td>
        <td class="stop-platform">${platformArr}</td>
      </tr>`;
  }

  _formatStart(departure) {
    if (!departure) return "–";
    const city = (this._config.hide_city || "").trim();
    if (!city) return departure;
    // Only remove ", City" at the end of the string (word boundary after city name)
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let result = departure
      .replace(new RegExp(",\\s*" + escaped + "\\b\\s*$", "i"), "")
      .trim();
    return result || departure;
  }

  _render() {
    if (!this._hass || !this._config) return;

    const sensors = this._getSensors();
    const title = this._config.title || "";
    const showStart = this._config.show_start;
    const threshold = this._config.delay_threshold;

    const rowsHtml = sensors.map((sensor, idx) => {
      const attr = sensor.attributes;
      const isExpanded = this._expandedRow === idx;
      const isOdd = idx % 2 !== 0;

      let details = attr.Details || [];
      if (typeof details === "string") {
        try {
          details = JSON.parse(details);
        } catch(e) {
          try {
            const fixed = details
              .replace(/'/g, '"')
              .replace(/\bNone\b/g, "null")
              .replace(/\bTrue\b/g, "true")
              .replace(/\bFalse\b/g, "false");
            details = JSON.parse(fixed);
          } catch(e2) { details = []; }
        }
      }
      if (!Array.isArray(details)) details = [];

      const problems = attr.Problems &&
        attr.Problems !== "null" &&
        attr.Problems !== null &&
        attr.Problems !== "None"
          ? attr.Problems : null;

      const depDelay = this._delayMinutes(attr["Departure Time"], attr["Departure Time Real"]);

      const segmentsHtml = details.map(seg => this._renderSegment(seg)).join("");

      const summaryHtml = `
        <tr class="detail-summary-row">
          <td colspan="4">
            <span class="summary-pill">⏱ ${attr.Duration || "–"}</span>
            <span class="summary-pill">🔁 ${attr.Transfers !== undefined ? attr.Transfers : "–"} Umstiege</span>
            ${depDelay > 0 ? `<span class="summary-pill delay-pill">+${depDelay} Min Verspätung</span>` : ""}
            ${problems ? `<span class="summary-pill problem-pill">⚠️ ${problems}</span>` : ""}
          </td>
        </tr>`;

      const bgStyle = isOdd
        ? "background-color:var(--table-row-alternative-background-color);"
        : "background-color:var(--table-row-background-color);";

      return `
        <tr class="main-row" data-idx="${idx}" style="${bgStyle}cursor:pointer;">
          ${showStart ? `<td class="left">${this._formatStart(attr.Departure)}</td>` : ""}
          <td class="left">${attr.Name || "–"}</td>
          <td class="center">${this._renderTimeCell(attr["Departure Time"], attr["Departure Time Real"], threshold)}</td>
          <td class="center">${this._renderTimeCell(attr["Arrival Time"], attr["Arrival Time Real"], threshold)}</td>
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

    const emptyHtml = sensors.length === 0
      ? `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--secondary-text-color)">
           Keine Verbindungen gefunden für Prefix: <code>${this._config.entity_prefix}</code>
         </td></tr>`
      : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }

        .card-wrap { overflow: auto; }

        table.main-table {
          width: 100%;
          padding: 16px;
          border-collapse: collapse;
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
        .delay-pill   { color: red; }
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

      <ha-card${title ? ` header="${title}"` : ""}>
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

    // Click handler
    this.shadowRoot.querySelectorAll(".main-row").forEach(row => {
      row.addEventListener("click", () => {
        const idx = parseInt(row.getAttribute("data-idx"));
        this._expandedRow = this._expandedRow === idx ? null : idx;
        this._render();
      });
    });
  }

  getCardSize() {
    return 5;
  }

  static getConfigElement() {
    return document.createElement("db-info-card-editor");
  }

  static getStubConfig() {
    return { entity_prefix: "", title: "", show_start: true, delay_threshold: 5, hide_city: "" };
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
    this._config = { show_start: true, delay_threshold: 5, hide_city: "", ...config };
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
    const threshold = this._config.delay_threshold ?? 5;
    const title = this._config.title || "";
    const hideCity = this._config.hide_city || "";

    const options = groups.map(([prefix, label]) =>
      `<option value="${prefix}" ${prefix === currentPrefix ? "selected" : ""}>${label}</option>`
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
          <input type="text" id="title" value="${title}" placeholder="z.B. Zuhause → Würzburg Hbf">
        </label>

        <label>
          Verspätungsschwellwert (Minuten, ab dem Rot angezeigt wird)
          <input type="number" id="threshold" value="${threshold}" min="1" max="60">
        </label>

        <label>
          Stadtname aus Start ausblenden (optional)
          <input type="text" id="hide_city" value="${hideCity}" placeholder="z.B. Würzburg">
          <span class="hint">Entfernt diesen Ortsnamen aus der Start-Spalte</span>
        </label>

        <div class="row">
          <label>
            <input type="checkbox" id="show_start" ${showStart ? "checked" : ""}>
            Startspalte anzeigen
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

    this.shadowRoot.getElementById("threshold").addEventListener("change", (e) => {
      this._config = { ...this._config, delay_threshold: parseInt(e.target.value) || 5 };
      this._fireChange();
    });

    this.shadowRoot.getElementById("show_start").addEventListener("change", (e) => {
      this._config = { ...this._config, show_start: e.target.checked };
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
    const showStart = this.shadowRoot.getElementById("show_start");
    const hideCity = this.shadowRoot.getElementById("hide_city");
    if (!prefix) return;
    if (document.activeElement !== prefix) prefix.value = this._config.entity_prefix || "";
    if (document.activeElement !== title) title.value = this._config.title || "";
    if (document.activeElement !== threshold) threshold.value = this._config.delay_threshold ?? 5;
    showStart.checked = this._config.show_start !== false;
    if (hideCity && document.activeElement !== hideCity) hideCity.value = this._config.hide_city || "";
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
