const HEART_RATE_SERVICE = "heart_rate";
const HEART_RATE_MEASUREMENT = "heart_rate_measurement";
const MAX_SAMPLES = 1800;
const DEFAULT_WINDOW_MS = 60_000;
const MIN_WINDOW_MS = 10_000;
const MAX_WINDOW_MS = 10 * 60_000;

const elements = {
  connectButton: document.querySelector("#connectButton"),
  disconnectButton: document.querySelector("#disconnectButton"),
  currentRate: document.querySelector("#currentRate"),
  minRate: document.querySelector("#minRate"),
  maxRate: document.querySelector("#maxRate"),
  message: document.querySelector("#message"),
  supportNote: document.querySelector("#supportNote"),
  statusBadge: document.querySelector("#statusBadge"),
  canvas: document.querySelector("#graphCanvas"),
  graphEmptyState: document.querySelector("#graphEmptyState"),
  zoomInButton: document.querySelector("#zoomInButton"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  zoomResetButton: document.querySelector("#zoomResetButton"),
};

const state = {
  currentRate: null,
  minRate: null,
  maxRate: null,
  samples: [],
  device: null,
  characteristic: null,
  connected: false,
  connecting: false,
  windowMs: DEFAULT_WINDOW_MS,
  renderScheduled: false,
  pinchDistance: null,
};

let resizeObserver = null;

function init() {
  bindEvents();
  updateSupportState();
  resizeCanvasToDisplaySize();
  scheduleRender();
  registerServiceWorker();
}

function bindEvents() {
  elements.connectButton.addEventListener("click", connectToHeartRateDevice);
  elements.disconnectButton.addEventListener("click", disconnectDevice);
  elements.zoomInButton.addEventListener("click", () => adjustZoom(0.75));
  elements.zoomOutButton.addEventListener("click", () => adjustZoom(1.25));
  elements.zoomResetButton.addEventListener("click", resetZoom);
  elements.canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      adjustZoom(event.deltaY < 0 ? 0.9 : 1.1);
    },
    { passive: false },
  );
  elements.canvas.addEventListener("pointerdown", handlePointerDown);
  elements.canvas.addEventListener("pointermove", handlePointerMove);
  elements.canvas.addEventListener("pointerup", handlePointerUp);
  elements.canvas.addEventListener("pointercancel", handlePointerUp);
  window.addEventListener("resize", handleResize);

  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(() => {
      resizeCanvasToDisplaySize();
      scheduleRender();
    });
    resizeObserver.observe(elements.canvas);
  }
}

function updateSupportState() {
  const issue = getBluetoothSupportIssue();

  if (issue) {
    elements.connectButton.disabled = true;
    setStatus("非対応", "error");
    setMessage(issue);
    setSupportNote(getLaunchHint());
  } else {
    setStatus("未接続");
    setSupportNote(getLaunchHint());
  }

  syncButtons();
}

async function connectToHeartRateDevice() {
  if (state.connecting) {
    return;
  }

  const issue = getBluetoothSupportIssue();
  if (issue) {
    updateSupportState();
    return;
  }

  try {
    state.connecting = true;
    syncButtons();
    setStatus("接続中", "pending");
    setMessage("心拍計を選択してください。");

    if (state.device?.gatt?.connected) {
      disconnectDevice();
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HEART_RATE_SERVICE] }],
    });

    device.removeEventListener("gattserverdisconnected", handleDisconnected);
    device.addEventListener("gattserverdisconnected", handleDisconnected);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(HEART_RATE_SERVICE);
    const characteristic = await service.getCharacteristic(
      HEART_RATE_MEASUREMENT,
    );

    characteristic.removeEventListener(
      "characteristicvaluechanged",
      handleHeartRateMeasurement,
    );
    characteristic.addEventListener(
      "characteristicvaluechanged",
      handleHeartRateMeasurement,
    );
    await characteristic.startNotifications();

    state.device = device;
    state.characteristic = characteristic;
    state.connected = true;

    setStatus("接続済み", "connected");
    setMessage("心拍データの受信を待っています。");
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "NotFoundError";
    setStatus("未接続", cancelled ? undefined : "error");
    setMessage(
      cancelled
        ? "心拍計の選択がキャンセルされました。"
        : `接続に失敗しました: ${error.message}`,
    );
  } finally {
    state.connecting = false;
    syncButtons();
  }
}

function disconnectDevice() {
  if (state.device?.gatt?.connected) {
    state.device.gatt.disconnect();
  }
}

function handleDisconnected() {
  if (state.characteristic) {
    state.characteristic.removeEventListener(
      "characteristicvaluechanged",
      handleHeartRateMeasurement,
    );
  }

  if (state.device) {
    state.device.removeEventListener("gattserverdisconnected", handleDisconnected);
  }

  state.connected = false;
  state.device = null;
  state.characteristic = null;
  syncButtons();
  setStatus("切断", "error");
  setMessage("心拍計との接続が切れました。再接続できます。");
}

function handleHeartRateMeasurement(event) {
  const value = event.target.value;
  const bpm = parseHeartRate(value);

  if (typeof bpm !== "number" || Number.isNaN(bpm)) {
    return;
  }

  const timestamp = performance.now();
  state.currentRate = bpm;
  state.minRate = state.minRate === null ? bpm : Math.min(state.minRate, bpm);
  state.maxRate = state.maxRate === null ? bpm : Math.max(state.maxRate, bpm);
  state.samples.push({ timestamp, value: bpm });

  if (state.samples.length > MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  }

  setMetric(elements.currentRate, bpm);
  setMetric(elements.minRate, state.minRate);
  setMetric(elements.maxRate, state.maxRate);
  setStatus("計測中", "connected");
  setMessage("Bluetooth Low Energy通知で心拍数をリアルタイム更新中です。");
  toggleGraphEmptyState(false);
  scheduleRender();
}

function parseHeartRate(dataView) {
  const flags = dataView.getUint8(0);
  const isUInt16 = (flags & 0x01) === 0x01;
  return isUInt16 ? dataView.getUint16(1, true) : dataView.getUint8(1);
}

function setMetric(element, value) {
  element.textContent = value === null ? "--" : String(value);
}

function setMessage(message) {
  elements.message.textContent = message;
}

function setSupportNote(message) {
  elements.supportNote.textContent = message;
}

function setStatus(label, tone) {
  elements.statusBadge.textContent = label;
  if (tone) {
    elements.statusBadge.dataset.tone = tone;
  } else {
    delete elements.statusBadge.dataset.tone;
  }
}

function syncButtons() {
  const unavailable = Boolean(getBluetoothSupportIssue());
  elements.connectButton.disabled = unavailable || state.connecting;
  elements.disconnectButton.disabled = !state.connected;
  elements.connectButton.textContent = state.connected ? "別の心拍計に接続" : "心拍計に接続";
}

function getBluetoothSupportIssue() {
  if (!window.isSecureContext) {
    return "このページは安全なURLではないため、Bluetoothを使えません。HTTPSまたはlocalhostで開いてください。";
  }

  if (!("bluetooth" in navigator) || typeof navigator.bluetooth.requestDevice !== "function") {
    return "このChrome環境ではWeb Bluetoothが使えません。Android ChromeまたはmacOS Chromeの対応環境で開いてください。";
  }

  return "";
}

function getLaunchHint() {
  const currentUrl = `${location.protocol}//${location.host || "(hostなし)"}`;

  if (!window.isSecureContext) {
    return `現在のURLは ${currentUrl} です。スマホ実機ではHTTPS公開URLが必要です。Macのローカル確認なら http://localhost:8000 のような localhost を使ってください。`;
  }

  return `現在のURL: ${currentUrl}。このアプリは外部サーバーへ心拍データを送信せず、ページ再読み込みでデータを初期化します。`;
}

function adjustZoom(multiplier) {
  const next = clamp(state.windowMs * multiplier, MIN_WINDOW_MS, MAX_WINDOW_MS);
  if (next !== state.windowMs) {
    state.windowMs = next;
    scheduleRender();
  }
}

function resetZoom() {
  state.windowMs = DEFAULT_WINDOW_MS;
  scheduleRender();
}

function toggleGraphEmptyState(show) {
  if (show) {
    delete elements.graphEmptyState.dataset.hidden;
  } else {
    elements.graphEmptyState.dataset.hidden = "true";
  }
}

function handleResize() {
  resizeCanvasToDisplaySize();
  scheduleRender();
}

function resizeCanvasToDisplaySize() {
  const canvas = elements.canvas;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function scheduleRender() {
  if (state.renderScheduled) {
    return;
  }

  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    renderGraph();
  });
}

function renderGraph() {
  const canvas = elements.canvas;
  const context = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  drawGraphBackground(context, width, height);

  if (state.samples.length === 0) {
    toggleGraphEmptyState(true);
    return;
  }

  toggleGraphEmptyState(false);

  const padding = { top: 20, right: 18, bottom: 34, left: 48 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const latest = state.samples[state.samples.length - 1].timestamp;
  const startTime = Math.max(0, latest - state.windowMs);
  const visibleSamples = state.samples.filter((sample) => sample.timestamp >= startTime);
  const values = visibleSamples.map((sample) => sample.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const span = Math.max(8, maxValue - minValue || 1);
  const yMin = Math.max(30, Math.floor(minValue - span * 0.25));
  const yMax = Math.ceil(maxValue + span * 0.25);

  drawGrid(context, padding, innerWidth, innerHeight, yMin, yMax, latest, startTime);
  drawLine(context, padding, innerWidth, innerHeight, visibleSamples, yMin, yMax, latest, startTime);
}

function drawGraphBackground(context, width, height) {
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0.96)");
  gradient.addColorStop(1, "rgba(255, 244, 237, 0.98)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function drawGrid(context, padding, innerWidth, innerHeight, yMin, yMax, latest, startTime) {
  context.save();
  context.strokeStyle = "rgba(154, 52, 18, 0.12)";
  context.lineWidth = 1;
  context.fillStyle = "rgba(124, 90, 71, 0.92)";
  context.font = '12px "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif';
  context.textAlign = "right";
  context.textBaseline = "middle";

  const yTicks = 4;
  for (let index = 0; index <= yTicks; index += 1) {
    const ratio = index / yTicks;
    const y = padding.top + innerHeight * ratio;
    const labelValue = Math.round(yMax - (yMax - yMin) * ratio);

    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + innerWidth, y);
    context.stroke();
    context.fillText(String(labelValue), padding.left - 10, y);
  }

  context.textAlign = "center";
  context.textBaseline = "top";
  const xTicks = 4;
  for (let index = 0; index <= xTicks; index += 1) {
    const ratio = index / xTicks;
    const x = padding.left + innerWidth * ratio;
    const time = startTime + (latest - startTime) * ratio;
    const secondsAgo = Math.max(0, Math.round((latest - time) / 1000));

    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, padding.top + innerHeight);
    context.stroke();
    context.fillText(`${secondsAgo}s前`, x, padding.top + innerHeight + 8);
  }

  context.restore();
}

function drawLine(context, padding, innerWidth, innerHeight, visibleSamples, yMin, yMax, latest, startTime) {
  if (visibleSamples.length === 0) {
    return;
  }

  const xFor = (timestamp) =>
    padding.left + ((timestamp - startTime) / Math.max(1, latest - startTime)) * innerWidth;
  const yFor = (value) =>
    padding.top + (1 - (value - yMin) / Math.max(1, yMax - yMin)) * innerHeight;

  context.save();

  context.strokeStyle = "rgba(234, 88, 12, 0.24)";
  context.lineWidth = 10;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  visibleSamples.forEach((sample, index) => {
    const x = xFor(sample.timestamp);
    const y = yFor(sample.value);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();

  const gradient = context.createLinearGradient(
    padding.left,
    padding.top,
    padding.left,
    padding.top + innerHeight,
  );
  gradient.addColorStop(0, "#ea580c");
  gradient.addColorStop(1, "#c2410c");
  context.strokeStyle = gradient;
  context.lineWidth = 3;
  context.beginPath();
  visibleSamples.forEach((sample, index) => {
    const x = xFor(sample.timestamp);
    const y = yFor(sample.value);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();

  const lastSample = visibleSamples[visibleSamples.length - 1];
  const lastX = xFor(lastSample.timestamp);
  const lastY = yFor(lastSample.value);

  context.fillStyle = "#9a3412";
  context.beginPath();
  context.arc(lastX, lastY, 4.5, 0, Math.PI * 2);
  context.fill();

  context.restore();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function handlePointerDown(event) {
  elements.canvas.setPointerCapture(event.pointerId);
  if (event.pointerType !== "touch") {
    return;
  }

  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (activePointers.size === 2) {
    state.pinchDistance = getPinchDistance();
  }
}

function handlePointerMove(event) {
  if (!activePointers.has(event.pointerId)) {
    return;
  }

  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (activePointers.size !== 2) {
    return;
  }

  const nextDistance = getPinchDistance();
  if (state.pinchDistance === null) {
    state.pinchDistance = nextDistance;
    return;
  }

  const delta = nextDistance - state.pinchDistance;
  if (Math.abs(delta) < 8) {
    return;
  }

  adjustZoom(delta > 0 ? 0.96 : 1.04);
  state.pinchDistance = nextDistance;
}

function handlePointerUp(event) {
  activePointers.delete(event.pointerId);
  if (activePointers.size < 2) {
    state.pinchDistance = null;
  }
}

const activePointers = new Map();

function getPinchDistance() {
  const points = [...activePointers.values()];
  if (points.length < 2) {
    return 0;
  }

  const [a, b] = points;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("Service Worker registration failed:", error);
  }
}

init();
