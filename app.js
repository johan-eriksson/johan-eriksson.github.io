const API_BASE = "https://www.elprisetjustnu.se/api/v1/prices";
const CACHE_PREFIX = "se4-prices-";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

const markupInput = document.getElementById("markup");
const gridFeeInput = document.getElementById("gridFee");
const momsInput = document.getElementById("moms");
const statusEl = document.getElementById("status");
const chartContainer = document.getElementById("chart");

let chart;

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function apiUrl(date) {
  const year = date.getFullYear();
  const monthDay = dateKey(date).slice(5);
  return `${API_BASE}/${year}/${monthDay}_SE4.json`;
}

function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("se4-settings") || "{}");
    markupInput.value = saved.markup ?? 5;
    gridFeeInput.value = saved.gridFee ?? 25;
    momsInput.checked = saved.moms > 1.12
  } catch {
    markupInput.value = 5;
    gridFeeInput.value = 25;
    momsInput.checked = true;
  }
}

function saveSettings() {
  const settings = {
    markup: Math.max(0, Number(markupInput.value) || 0),
    gridFee: Math.max(0, Number(gridFeeInput.value) || 0),
    moms: momsInput.checked ? 1.25 : 1.0
  };
  localStorage.setItem("se4-settings", JSON.stringify(settings));
  renderChart();
}

function readCache(date) {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + dateKey(date)) || "null");
    if (!cached || !Array.isArray(cached.data)) return null;
    const fresh = Date.now() - cached.savedAt < CACHE_TTL_MS;
    return { data: cached.data, fresh };
  } catch {
    return null;
  }
}

function writeCache(date, data) {
  localStorage.setItem(CACHE_PREFIX + dateKey(date), JSON.stringify({
    savedAt: Date.now(),
    data
  }));
}

async function fetchDay(date, force = false) {
  const cached = readCache(date);
  if (!force && cached?.fresh) return { data: cached.data, fromCache: true };

  try {
    const response = await fetch(apiUrl(date), { cache: "no-store" });
    if (!response.ok) {
      if (cached) return { data: cached.data, fromCache: true, stale: true };
      if (response.status === 404) return { data: [], unavailable: true };
      throw new Error(`API svarade med HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("Oväntat svarsformat från pris-API:et");
    writeCache(date, data);
    return { data, fromCache: false };
  } catch (error) {
    if (cached) return { data: cached.data, fromCache: true, stale: true };
    throw error;
  }
}

function formatPrice(value) {
  return `${value.toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} öre`;
}

function toChartRows(dayData) {
  return dayData.map(item => {
    const spotOre = Number(item.SEK_per_kWh) * 100;
    const markup = Math.max(0, Number(markupInput.value) || 0);
    const gridFee = Math.max(0, Number(gridFeeInput.value) || 0);
    const moms = momsInput.checked ? 1.25 : 1;
    const time = new Date(item.time_start);
    return {
      time: time,
      spot: Number(spotOre.toFixed(3)),
      total: Number((moms * (spotOre + markup) + gridFee).toFixed(3))
    };
  }).filter(row => Number.isFinite(row.spot));
}

function updateSummary(todayRows, tomorrowRows) {
  const all = [...todayRows, ...tomorrowRows];
  const average = rows => rows.length
    ? rows.reduce((sum, row) => sum + row.total, 0) / rows.length
    : null;

  const todayAvg = average(todayRows);
  const tomorrowAvg = average(tomorrowRows);
  document.getElementById("todayAverage").textContent = todayAvg == null ? "-" : formatPrice(todayAvg);
  document.getElementById("tomorrowAverage").textContent = tomorrowAvg == null ? "-" : formatPrice(tomorrowAvg);

  if (!all.length) {
    document.getElementById("lowestPrice").textContent = "-";
    document.getElementById("lowestTime").textContent = "Ingen prisdata";
    return;
  }
  const lowest = all.reduce((min, row) => row.total < min.total ? row : min);
  document.getElementById("lowestPrice").textContent = formatPrice(lowest.total);
  document.getElementById("lowestTime").textContent = lowest.time;
}

function renderChart() {
  if (!window.agCharts?.AgCharts || !chart) return;
  const markup = Math.max(0, Number(markupInput.value) || 0);
  const gridFee = Math.max(0, Number(gridFeeInput.value) || 0);
  const moms = momsInput.checked ? 1.25 : 1;
  const rows = window.currentPriceRows || [];
  const data = rows.map(row => ({
    ...row,
    total: Number((moms * (row.spot + markup) + gridFee).toFixed(3))
  }));

  chart.updateDelta({
    data,
  });
}

function createChart(data) {
  const options = {
    container: chartContainer,
    data,
    theme: 'ag-default-dark',
    padding: { top: 18, right: 18, bottom: 12, left: 12 },
    legend: { enabled: true, position: "bottom" },
    series: [
      { type: "line", xKey: "time", yKey: "spot", yName: "Spotpris", marker: { enabled: false }, strokeWidth: 2 },
      { type: "line", xKey: "time", yKey: "total", yName: "Inkl. dina avgifter", marker: { enabled: false }, strokeWidth: 3 }
    ],
    axes: {
      x: {
        type: "time",
        crossLines: [
          {
            type: 'line',
            value: new Date(),
          }
        ],
        title: { text: "Tid" },
        label: { rotation: 0, avoidCollisions: true }
      },
      y: {
        type: "number",
        title: { text: "Öre/kWh" },
        label: { formatter: params => `${params.value}` },
      }
    }
  };
  chart = agCharts.AgCharts.create(options);
}

async function loadPrices(force = false) {
  const button = document.getElementById("refreshButton");
  button.disabled = true;
  statusEl.textContent = "Hämtar priser…";
  try {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const [todayResult, tomorrowResult] = await Promise.all([
      fetchDay(today, force),
      fetchDay(tomorrow, force)
    ]);

    const todayRows = toChartRows(todayResult.data);
    const tomorrowRows = toChartRows(tomorrowResult.data);
    const allRows = [...todayRows, ...tomorrowRows];
    window.currentPriceRows = allRows;

    if (!chart) createChart(allRows);
    else renderChart();

    updateSummary(todayRows, tomorrowRows);

    const notes = [];
    if (todayResult.fromCache || tomorrowResult.fromCache) notes.push("cache");
    if (todayResult.stale || tomorrowResult.stale) notes.push("visar senast sparade data");
    if (tomorrowResult.unavailable) notes.push("morgondagens priser är ännu inte publicerade");
    if (!todayRows.length) notes.push("inga priser för idag");
    statusEl.textContent = notes.length ? notes.join(" · ") : `Uppdaterad ${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    statusEl.textContent = `Kunde inte hämta priser: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

readSettings();
markupInput.addEventListener("input", saveSettings);
gridFeeInput.addEventListener("input", saveSettings);
momsInput.addEventListener("input", saveSettings);
document.getElementById("refreshButton").addEventListener("click", () => loadPrices(true));

loadPrices();
