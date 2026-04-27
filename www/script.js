/**
 * micro:bit Emoji Display - Dual Transport (Serial + BLE)
 * Transport abstraction layer for USB Serial and Bluetooth LE
 */

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════
const CONFIG = {
  // Serial settings
  serial: {
    baudRate: 115200,
    chunkSize: 50,
    ackTimeout: 100,
    retryDelay: 20,
    maxRetries: 10,
    maxSeq: 1000
  },
  // BLE settings
  ble: {
    serviceUUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    txCharUUID: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',  // notify (micro:bit → web)
    rxCharUUID: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',  // write (web → micro:bit)
    maxWriteBytes: 20,
    ackTimeout: 4000,  // BLE needs longer timeout
    retryDelay: 50,
    maxRetries: 5,
    maxSeq: 1000
  }
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ═══════════════════════════════════════════════════════════════════
// TRANSPORT ABSTRACTION LAYER
// ═══════════════════════════════════════════════════════════════════

/**
 * Base Transport Interface
 * Both Serial and BLE transports implement this interface
 */
class Transport {
  constructor() {
    this.isConnected = false;
    this.rxBuffer = '';
    this.onReceiveLine = null;  // Callback for received lines
    this.onDisconnect = null;   // Callback for disconnection
    
    // ACK state
    this.awaitingPayload = null;
    this.awaitingResolve = null;
    this.awaitingReject = null;
    this.awaitingTimer = null;
  }
  
  get name() { return 'base'; }
  get config() { return {}; }
  
  async connect() { throw new Error('Not implemented'); }
  async disconnect() { throw new Error('Not implemented'); }
  async writeRaw(data) { throw new Error('Not implemented'); }
  
  // Common RX processing
  processRxData(data) {
    this.rxBuffer += (typeof data === 'string') 
      ? data.replace(/\r/g, '') 
      : decoder.decode(data).replace(/\r/g, '');
    
    let nl;
    while ((nl = this.rxBuffer.indexOf('\n')) !== -1) {
      const line = this.rxBuffer.slice(0, nl).trim();
      this.rxBuffer = this.rxBuffer.slice(nl + 1);
      if (!line) continue;
      
      if (this.onReceiveLine) {
        this.onReceiveLine(line);
      }
    }
  }
  
  // ACK handling
  abortAck(reason) {
    if (this.awaitingTimer) clearTimeout(this.awaitingTimer);
    if (this.awaitingReject) this.awaitingReject(new Error(reason));
    this.awaitingPayload = this.awaitingResolve = this.awaitingReject = null;
  }
  
  waitForAck(payload, timeout) {
    return new Promise((resolve, reject) => {
      this.awaitingPayload = payload;
      this.awaitingResolve = resolve;
      this.awaitingReject = reject;
      this.awaitingTimer = setTimeout(() => {
        this.abortAck('ACK timeout');
        reject(new Error('ACK timeout'));
      }, timeout || this.config.ackTimeout);
    });
  }
  
  tryResolveAck(echoed) {
    if (!this.awaitingResolve || !this.awaitingPayload) return false;
    
    // For chunked data: "seq|payload" - accept just the sequence number
    const barIdx = this.awaitingPayload.indexOf('|');
    if (barIdx > 0) {
      const expectedSeq = this.awaitingPayload.substring(0, barIdx);
      
      // Accept sequence-only ACK (lightweight protocol)
      if (echoed === expectedSeq) {
        clearTimeout(this.awaitingTimer);
        const resolve = this.awaitingResolve;
        this.awaitingPayload = this.awaitingResolve = this.awaitingReject = null;
        resolve(true);
        return true;
      }
      
      // Also accept full payload echo (backward compatibility)
      if (echoed === this.awaitingPayload) {
        clearTimeout(this.awaitingTimer);
        const resolve = this.awaitingResolve;
        this.awaitingPayload = this.awaitingResolve = this.awaitingReject = null;
        resolve(true);
        return true;
      }
    }
    
    // Exact match for non-chunked commands
    if (echoed === this.awaitingPayload) {
      clearTimeout(this.awaitingTimer);
      const resolve = this.awaitingResolve;
      this.awaitingPayload = this.awaitingResolve = this.awaitingReject = null;
      resolve(true);
      return true;
    }
    
    // OK response for simple commands
    if (echoed === 'OK') {
      clearTimeout(this.awaitingTimer);
      const resolve = this.awaitingResolve;
      this.awaitingPayload = this.awaitingResolve = this.awaitingReject = null;
      resolve(true);
      return true;
    }
    
    return false;
  }
  
  // Calculate max data length for a given sequence number
  maxDataLenForSeq(seq) {
    const seqLen = String(seq).length;
    const chunkSize = this.config.chunkSize || this.config.maxWriteBytes;
    return Math.max(1, chunkSize - 1 - seqLen - 1);
  }
}

/**
 * USB Serial Transport
 */
class SerialTransport extends Transport {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
  }
  
  get name() { return 'serial'; }
  get config() { return CONFIG.serial; }
  
  async connect() {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: this.config.baudRate });
    this.writer = this.port.writable.getWriter();
    this.rxBuffer = '';
    this.isConnected = true;
    this._startReadLoop();
    return true;
  }
  
  async disconnect() {
    this.isConnected = false;
    if (this.writer) { 
      await this.writer.close().catch(() => {}); 
      this.writer = null; 
    }
    if (this.reader) { 
      await this.reader.cancel().catch(() => {}); 
      this.reader = null; 
    }
    if (this.port) { 
      await this.port.close().catch(() => {}); 
      this.port = null; 
    }
    this.abortAck('Disconnected');
    if (this.onDisconnect) this.onDisconnect();
  }
  
  async writeRaw(data) {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(encoder.encode(data + '\n'));
  }
  
  async _startReadLoop() {
    while (this.port && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.processRxData(value);
        }
      } catch (error) {
        if (this.isConnected) {
          console.error('Serial read error:', error);
        }
      } finally {
        if (this.reader) {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    }
  }
}

/**
 * Bluetooth LE Transport (Nordic UART Service)
 */
class BLETransport extends Transport {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.service = null;
    this.notifyChar = null;
    this.writeChar = null;
  }
  
  get name() { return 'ble'; }
  get config() { return CONFIG.ble; }
  
  async connect() {
    // Request device
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [this.config.serviceUUID]
    });
    
    // Handle disconnection
    this.device.addEventListener('gattserverdisconnected', () => {
      this.isConnected = false;
      this.abortAck('Disconnected');
      if (this.onDisconnect) this.onDisconnect();
    });
    
    // Connect to GATT server
    this.server = await this.device.gatt.connect();
    this.service = await this.server.getPrimaryService(this.config.serviceUUID);
    
    // Get characteristics
    this.notifyChar = await this.service.getCharacteristic(this.config.txCharUUID);
    this.writeChar = await this.service.getCharacteristic(this.config.rxCharUUID);
    
    // Start notifications
    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', (event) => {
      this._onNotify(event);
    });
    
    this.rxBuffer = '';
    this.isConnected = true;
    return true;
  }
  
  async disconnect() {
    this.isConnected = false;
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.device = null;
    this.server = null;
    this.service = null;
    this.notifyChar = null;
    this.writeChar = null;
    this.abortAck('Disconnected');
    if (this.onDisconnect) this.onDisconnect();
  }
  
  async writeRaw(data) {
    if (!this.writeChar) throw new Error('Not connected');
    await this.writeChar.writeValue(encoder.encode(data + '\n'));
  }
  
  _onNotify(event) {
    let s = '';
    const v = event.target.value;
    for (let i = 0; i < v.byteLength; i++) {
      const b = v.getUint8(i);
      if (b !== 13) s += String.fromCharCode(b);  // Skip CR
    }
    this.processRxData(s);
  }
  
  // Override maxDataLenForSeq for BLE's smaller MTU
  maxDataLenForSeq(seq) {
    const seqLen = String(seq).length;
    // BLE: 20 bytes max, minus newline, minus "seq|"
    return Math.max(1, (this.config.maxWriteBytes - 1) - (seqLen + 1));
  }
}

// ═══════════════════════════════════════════════════════════════════
// DOM ELEMENTS
// ═══════════════════════════════════════════════════════════════════
const dom = {
  // Transport selection
  transportSelect: document.getElementById('transportSelect'),
  // Connection buttons
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  sendBtn: document.getElementById('sendBtn'),
  testBtn: document.getElementById('testBtn'),
  clearStatsBtn: document.getElementById('clearStatsBtn'),
  messageInput: document.getElementById('messageInput'),
  // Emoji UI
  emojiList: document.getElementById('emojiList'),
  emojiMatrix: document.getElementById('emojiMatrix'),
  sendEmojiBtn: document.getElementById('sendEmojiBtn'),
  matrixSize: document.getElementById('matrixSize'),
  brightnessSlider: document.getElementById('brightnessSlider'),
  brightnessValue: document.getElementById('brightnessValue'),
  simpleModeToggle: document.getElementById('simpleModeToggle'),
  brushColor: document.getElementById('brushColor'),
  // Preview controls
  clearPreviewBtn: document.getElementById('clearPreviewBtn'),
  testRedBtn: document.getElementById('testRedBtn'),
  testGreenBtn: document.getElementById('testGreenBtn'),
  testBlueBtn: document.getElementById('testBlueBtn'),
  testWhiteBtn: document.getElementById('testWhiteBtn'),
  // Save/Load
  saveNameInput: document.getElementById('saveNameInput'),
  saveDesignBtn: document.getElementById('saveDesignBtn'),
  savedDesignsList: document.getElementById('savedDesignsList'),
  noSavedDesigns: document.getElementById('noSavedDesigns'),
  // Demos
  demoWavingFlag: document.getElementById('demoWavingFlag'),
  demoTrafficLight: document.getElementById('demoTrafficLight'),
  demoHeartBeat: document.getElementById('demoHeartBeat'),
  demoSpinningStar: document.getElementById('demoSpinningStar'),
  demoRainbowWave: document.getElementById('demoRainbowWave'),
  demoSmiley: document.getElementById('demoSmiley'),
  demoLoadingBar: document.getElementById('demoLoadingBar'),
  demoFireworks: document.getElementById('demoFireworks'),
  demoRacingCar: document.getElementById('demoRacingCar'),
  demoStopSign: document.getElementById('demoStopSign'),
  demoBlinkingEye: document.getElementById('demoBlinkingEye'),
  stopDemo: document.getElementById('stopDemo'),
  logContainer: document.getElementById('logContainer'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  copyLogBtn: document.getElementById('copyLogBtn'),
  exportLogBtn: document.getElementById('exportLogBtn'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  statusPill: document.getElementById('statusPill'),
  // Transport indicator
  transportBadge: document.getElementById('transportBadge')
};

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
let transport = null;  // Current transport instance
let isConnected = false;
let sendInProgress = false;

// Emoji state
let selectedEmoji = null;
let selectedEmojiHex = null;

// Test statistics
let stats = {
  chunks: 0,
  retries: 0,
  maxRetryPerChunk: 0
};

// Cumulative statistics
let cumulative = {
  tests: 0,
  bytes: 0,
  chunks: 0,
  retries: 0,
  time: 0,
  minSpeed: Infinity,
  maxSpeed: 0,
  minRetries: Infinity,
  maxRetries: 0,
  maxRetryPerChunk: 0
};

// ═══════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timestamp = () => `[${new Date().toLocaleTimeString()}]`;

// ═══════════════════════════════════════════════════════════════════
// EMOJI → 16x16 BITMAP
// ═══════════════════════════════════════════════════════════════════

const EMOJI_LIBRARY = {
  '😀 Basic': [
    '😀','😃','😄','😁','😎','🥳','😍','🤖','👻','💀','👽','🎃',
    '❤️','💛','💚','💙','💜','⭐','⚡','🔥','❄️','🌈','🍀','🍕',
    '🍎','🍌','🍓','🍉','🎈','🎉','🎮','🎵','🚀','🧠','✅','❌'
  ],
  '🤖 Robots': [
    '🤖','👾','🛸','🦾','🦿','💡','🔋','⚙️','🔧','🔨','🪛','⚒️',
    '🛠️','🔩','⛓️','🧲','📡','📻','💻','⌨️','🖥️','📱','🖱️','💾'
  ],
  '🚗 Vehicles': [
    '🚗','🚙','🚕','🏎️','🚓','🚑','🚒','🚜','🦼','🦽','🛴','🛹',
    '🚲','🏍️','🛵','✈️','🚁','🛩️','🚂','🚃','🚄','🚅','🚆','🚇'
  ],
  '🔧 Tools': [
    '🔧','🔨','🪛','⚒️','🛠️','🪚','🪓','✂️','📏','📐','🧰','🗜️',
    '⛏️','🔪','🪒','🧪','🔬','🔭','⚗️','🧬','💉','🌡️','🧯','🪝'
  ],
  '🔴 Symbols': [
    '🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔸',
    '🔺','🔻','💠','🔘','⏺️','⏸️','⏹️','⏩','⏪','⏫','⏬','▶️',
    '◀️','🔼','🔽','⏏️','⚠️','☢️','☣️','⛔','🚫','❗','❓','💯'
  ],
  '🏴 Flags': [
    '🇫🇷','🇺🇸','🇬🇧','🇩🇿','🇵🇸','🇹🇳','🇲🇦','🇪🇬','🇶🇦','🇿🇦',
    '🇮🇪','🇪🇸','🇮🇹','🏴','🏳️','🏁','🚩','🏴‍☠️'
  ],
  '🛑 Road Signs': [
    '🛑','⚠️','🚸','⛔','🚫','🚷','🚳','🚭','🚯','🚱',
    '🚰','♿','🅿️','🚏','🛤️','🚦','🚥','⛽','🏧','ℹ️',
    '🆘','🆗','🆙','🆕','🆓','🔞','📵','🔇','🔕','⏸️',
    '⏹️','⏺️','⏏️','⏮️','⏭️','⏯️','🔁','🔂','◀️','▶️'
  ]
};

const EMOJI_DESCRIPTIONS = {
  '😀': 'Grinning Face - Happy smile',
  '😃': 'Grinning Face with Big Eyes',
  '😄': 'Grinning Face with Smiling Eyes',
  '😁': 'Beaming Face - Big grin',
  '😎': 'Smiling Face with Sunglasses - Cool',
  '🥳': 'Partying Face - Celebration',
  '😍': 'Smiling Face with Heart-Eyes - Love',
  '🤖': 'Robot Face - Technology',
  '👻': 'Ghost - Spooky',
  '💀': 'Skull - Danger or Halloween',
  '👽': 'Alien - Extraterrestrial',
  '🎃': 'Jack-O-Lantern - Halloween pumpkin',
  '❤️': 'Red Heart - Love',
  '💛': 'Yellow Heart - Friendship',
  '💚': 'Green Heart - Nature',
  '💙': 'Blue Heart - Trust',
  '💜': 'Purple Heart - Magic',
  '⭐': 'Star - Excellence',
  '⚡': 'Lightning Bolt - Power/Energy',
  '🔥': 'Fire - Hot or trending',
  '❄️': 'Snowflake - Cold or winter',
  '🌈': 'Rainbow - Colorful',
  '🍀': 'Four Leaf Clover - Good luck',
  '🍕': 'Pizza - Food',
  '🍎': 'Red Apple - Fruit or health',
  '🍌': 'Banana - Fruit',
  '🍓': 'Strawberry - Berry fruit',
  '🍉': 'Watermelon - Summer fruit',
  '🎈': 'Balloon - Party',
  '🎉': 'Party Popper - Celebration',
  '🎮': 'Video Game Controller - Gaming',
  '🎵': 'Musical Note - Music',
  '🚀': 'Rocket - Space or fast',
  '🧠': 'Brain - Intelligence',
  '✅': 'Check Mark - Correct/Done',
  '❌': 'Cross Mark - Wrong/Error',
  '🛑': 'STOP Sign',
  '⚠️': 'Warning Sign',
  '🚸': 'Children Crossing',
  '⛔': 'No Entry',
  '🚫': 'Prohibited',
  '🇫🇷': 'France Flag',
  '🇺🇸': 'USA Flag',
  '🇬🇧': 'UK Flag',
  '🇩🇿': 'Algeria Flag',
  '🇵🇸': 'Palestine Flag'
};

function ensureEmojiMatrixGrid() {
  if (!dom.emojiMatrix) return;
  
  const matrixSize = parseInt(dom.matrixSize?.value || '8');
  const numCells = matrixSize * matrixSize;
  
  if (dom.emojiMatrix.childElementCount === numCells) return;

  dom.emojiMatrix.innerHTML = '';
  dom.emojiMatrix.style.gridTemplateColumns = `repeat(${matrixSize}, 1fr)`;
  
  for (let i = 0; i < numCells; i++) {
    const cell = document.createElement('div');
    cell.className = 'pixel-cell';
    cell.dataset.index = String(i);
    dom.emojiMatrix.appendChild(cell);
  }
}

function renderEmojiToRGB(emoji, targetSize = 16) {
  const W = 64, H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '56px system-ui, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji';
  ctx.fillText(emoji, W / 2, H / 2 + 2);

  const img = ctx.getImageData(0, 0, W, H).data;
  const colors = [];

  const cell = Math.floor(64 / targetSize);
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let totalR = 0, totalG = 0, totalB = 0;
      let count = 0;

      for (let yy = 0; yy < cell; yy++) {
        for (let xx = 0; xx < cell; xx++) {
          const px = x * cell + xx;
          const py = y * cell + yy;
          const idx = (py * W + px) * 4;
          const r = img[idx + 0];
          const g = img[idx + 1];
          const b = img[idx + 2];
          const a = img[idx + 3];
          
          if (a > 40) {
            totalR += r;
            totalG += g;
            totalB += b;
            count++;
          }
        }
      }

      if (count > 2) {
        colors.push({
          r: Math.round(totalR / count),
          g: Math.round(totalG / count),
          b: Math.round(totalB / count)
        });
      } else {
        colors.push({ r: 0, g: 0, b: 0 });
      }
    }
  }

  return colors;
}

function rgbToHex(colors) {
  const hex = [];
  for (const color of colors) {
    hex.push(color.r.toString(16).padStart(2, '0'));
    hex.push(color.g.toString(16).padStart(2, '0'));
    hex.push(color.b.toString(16).padStart(2, '0'));
  }
  return hex.join('');
}

function calculateChecksum(hexData) {
  let sum = 0;
  for (let i = 0; i < hexData.length; i++) {
    const nibble = parseInt(hexData.charAt(i), 16);
    sum = (sum + nibble) % 256;
  }
  return sum.toString(16).padStart(2, '0').toUpperCase();
}

function paintEmojiMatrix(data) {
  if (!dom.emojiMatrix) return;
  ensureEmojiMatrixGrid();
  const cells = dom.emojiMatrix.children;
  
  if (data[0] && typeof data[0] === 'object' && 'r' in data[0]) {
    const max = Math.min(cells.length, data.length);
    for (let i = 0; i < max; i++) {
      const color = data[i];
      const isOn = color.r > 10 || color.g > 10 || color.b > 10;
      cells[i].classList.toggle('on', isOn);
      if (isOn) {
        cells[i].style.background = `rgb(${color.r}, ${color.g}, ${color.b})`;
        cells[i].style.boxShadow = `0 0 8px rgba(${color.r}, ${color.g}, ${color.b}, 0.8)`;
      } else {
        cells[i].style.background = '';
        cells[i].style.boxShadow = '';
      }
    }
  }
}

function buildEmojiPicker() {
  if (!dom.emojiList) return;

  dom.emojiList.innerHTML = '';
  dom.emojiList.classList.remove('emoji-grid');
  dom.emojiList.classList.add('emoji-categories');

  for (const [categoryName, emojis] of Object.entries(EMOJI_LIBRARY)) {
    const categorySection = document.createElement('details');
    categorySection.className = 'emoji-category';
    categorySection.open = categoryName === '😀 Basic';

    const summary = document.createElement('summary');
    summary.className = 'emoji-category-title';
    summary.textContent = categoryName;
    categorySection.appendChild(summary);

    const grid = document.createElement('div');
    grid.className = 'emoji-grid';
    
    for (const emoji of emojis) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-btn';
      btn.textContent = emoji;
      btn.setAttribute('data-description', EMOJI_DESCRIPTIONS[emoji] || 'Custom emoji');
      btn.addEventListener('click', () => selectEmoji(emoji, btn));
      grid.appendChild(btn);
    }

    categorySection.appendChild(grid);
    dom.emojiList.appendChild(categorySection);
  }

  ensureEmojiMatrixGrid();
  initEditablePreview();
}

function selectEmoji(emoji, btnEl) {
  selectedEmoji = emoji;

  if (dom.emojiList) {
    const allButtons = dom.emojiList.querySelectorAll('.emoji-btn');
    allButtons.forEach(btn => btn.classList.remove('active'));
  }
  if (btnEl) btnEl.classList.add('active');

  const matrixSize = parseInt(dom.matrixSize?.value || '8');
  const colors = renderEmojiToRGB(emoji, matrixSize);
  setPreviewFromColors(colors, emoji);

  if (dom.sendEmojiBtn) dom.sendEmojiBtn.disabled = !isConnected;
}

async function sendEmoji() {
  if (!selectedEmojiHex) {
    log('Pick an emoji first', 'error');
    return;
  }
  if (!isConnected) {
    log('Not connected', 'error');
    return;
  }
  if (sendInProgress) return;

  showLoadingIndicator('Sending emoji...');
  
  try {
    const checksum = calculateChecksum(selectedEmojiHex);
    const payload = `RGBMOJI:${selectedEmojiHex}|${checksum}`;
    const byteLen = encoder.encode(payload).length;

    log(`Sending colorized emoji (${byteLen} bytes) via ${transport.name.toUpperCase()}`, 'info');

    await sendChunked(payload);
  } finally {
    hideLoadingIndicator();
  }
}

// Send current preview colors to micro:bit (for demos)
let demoSendInProgress = false;
let statusOkResolver = null;

async function sendCurrentFrame() {
  if (!isConnected || demoSendInProgress) return;
  
  demoSendInProgress = true;
  
  try {
    const hexData = rgbToHex(previewColors);
    const checksum = calculateChecksum(hexData);
    const payload = `RGBMOJI:${hexData}|${checksum}`;
    
    const statusPromise = new Promise((resolve) => {
      statusOkResolver = resolve;
      setTimeout(() => {
        if (statusOkResolver === resolve) {
          statusOkResolver = null;
          resolve(false);
        }
      }, 2000);
    });
    
    await sendChunked(payload);
    await statusPromise;
  } catch (err) {
    console.error('Demo frame send error:', err);
  } finally {
    demoSendInProgress = false;
  }
}

function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-line ${type}`;
  div.textContent = `${timestamp()} ${msg}`;
  dom.logContainer.appendChild(div);
  dom.logContainer.scrollTop = dom.logContainer.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════
//  📡 LOADING INDICATOR
// ═══════════════════════════════════════════════════════════════════

const loadingMessages = [
  'Sending to micro:bit...',
  'Transferring data...',
  'Streaming pixels...',
  'Uploading emoji...',
  'Beaming to device...',
];

function showLoadingIndicator(message) {
  const indicator = document.getElementById('loadingIndicator');
  const messageEl = document.getElementById('loadingMessage');
  
  if (indicator && messageEl) {
    messageEl.textContent = message || loadingMessages[Math.floor(Math.random() * loadingMessages.length)];
    indicator.style.display = 'block';
    indicator.style.animation = 'slideIn 0.3s ease-out';
  }
}

function hideLoadingIndicator() {
  const indicator = document.getElementById('loadingIndicator');
  if (indicator) {
    indicator.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => {
      indicator.style.display = 'none';
    }, 300);
  }
}

function clearLog() {
  dom.logContainer.innerHTML = '';
  log('Log cleared');
}

function clearStats() {
  cumulative.tests = 0;
  cumulative.bytes = 0;
  cumulative.chunks = 0;
  cumulative.retries = 0;
  cumulative.time = 0;
  cumulative.minSpeed = Infinity;
  cumulative.maxSpeed = 0;
  cumulative.minRetries = Infinity;
  cumulative.maxRetries = 0;
  cumulative.maxRetryPerChunk = 0;
  log('Stats cleared', 'success');
}

function getLogText() {
  return Array.from(dom.logContainer.children).map(d => d.textContent).join('\n');
}

async function copyLog() {
  await navigator.clipboard.writeText(getLogText());
  log('Logs copied to clipboard', 'success');
}

function exportLog() {
  const blob = new Blob([getLogText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'microbit-log.txt';
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════
function setConnected(connected) {
  isConnected = connected;
  
  const transportName = transport ? transport.name.toUpperCase() : 'N/A';
  dom.statusText.textContent = connected ? `Connected (${transportName})` : 'Disconnected';
  dom.statusDot.classList.toggle('connected', connected);
  dom.statusPill.classList.toggle('connected', connected);
  dom.connectBtn.disabled = connected;
  dom.disconnectBtn.disabled = !connected;
  dom.sendBtn.disabled = !connected;
  if (dom.sendEmojiBtn) dom.sendEmojiBtn.disabled = !connected;
  if (dom.testBtn) dom.testBtn.disabled = !connected;
  
  // Update transport badge
  if (dom.transportBadge) {
    if (connected && transport) {
      dom.transportBadge.textContent = transport.name.toUpperCase();
      dom.transportBadge.className = `badge transport-${transport.name}`;
    } else {
      dom.transportBadge.textContent = 'N/A';
      dom.transportBadge.className = 'badge';
    }
  }
  
  // Disable transport selector when connected
  if (dom.transportSelect) {
    dom.transportSelect.disabled = connected;
  }
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTION (Transport-agnostic)
// ═══════════════════════════════════════════════════════════════════

function createTransport(type) {
  switch (type) {
    case 'ble':
      return new BLETransport();
    case 'serial':
    default:
      return new SerialTransport();
  }
}

async function connect() {
  const transportType = dom.transportSelect?.value || 'serial';
  transport = createTransport(transportType);
  
  // Set up callbacks
  transport.onReceiveLine = handleReceivedLine;
  transport.onDisconnect = () => {
    setConnected(false);
    log(`Disconnected from ${transport.name.toUpperCase()}`, 'error');
  };
  
  try {
    await transport.connect();
    setConnected(true);
    log(`Connected via ${transport.name.toUpperCase()}`, 'success');
    
    // Initialize micro:bit state
    await delay(100);
    await sendRaw('CLEAR');
    await delay(50);
    
    const matrixSize = parseInt(dom.matrixSize?.value || '8');
    await sendMode(matrixSize);
    
    const brightness = parseInt(dom.brightnessSlider?.value || '10');
    await sendBrightness(brightness);
    
  } catch (err) {
    log(`Connection failed: ${err.message}`, 'error');
    transport = null;
  }
}

async function disconnect() {
  if (transport) {
    await transport.disconnect();
    transport = null;
  }
  setConnected(false);
  log('Disconnected', 'error');
}

// ═══════════════════════════════════════════════════════════════════
// RX PROCESSING
// ═══════════════════════════════════════════════════════════════════

function handleReceivedLine(line) {
  log('← ' + line, 'rx');
  
  if (line.startsWith('>')) {
    transport.tryResolveAck(line.slice(1));
  } else if (line.startsWith('STATUS:')) {
    handleStatusMessage(line.slice(7));
  }
}

function handleStatusMessage(status) {
  const parts = status.split('|');
  const result = parts[0];
  const mbChecksum = parts[1];
  const sentChecksum = parts[2];
  
  if (result === 'OK') {
    showStatusBadge(`✓ 0x${mbChecksum}`, '#10b981', 2000);
    log(`✓ Checksum OK: 0x${mbChecksum}`, 'success');
    if (statusOkResolver) {
      const resolver = statusOkResolver;
      statusOkResolver = null;
      resolver(true);
    }
  } else if (result === 'BAD') {
    showStatusBadge(`✗ 0x${mbChecksum}≠0x${sentChecksum}`, '#ef4444', 4000);
    log(`✗ Checksum FAILED! Calculated: 0x${mbChecksum}, Expected: 0x${sentChecksum}`, 'error');
    if (statusOkResolver) {
      const resolver = statusOkResolver;
      statusOkResolver = null;
      resolver(false);
    }
  }
}

function showStatusBadge(icon, color, duration) {
  const badge = document.createElement('div');
  badge.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${color};
    color: white;
    padding: 10px 16px;
    border-radius: 50px;
    font-size: 1.2rem;
    font-weight: bold;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
    animation: slideIn 0.3s ease-out;
  `;
  badge.textContent = icon;
  document.body.appendChild(badge);
  
  setTimeout(() => {
    badge.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => badge.remove(), 300);
  }, duration);
}

// ═══════════════════════════════════════════════════════════════════
// TX (Transport-agnostic)
// ═══════════════════════════════════════════════════════════════════

async function sendRaw(msg) {
  if (!transport) throw new Error('Not connected');
  await transport.writeRaw(msg);
  log('→ ' + msg, 'tx');
}

// ═══════════════════════════════════════════════════════════════════
// CHUNKED TRANSFER
// ═══════════════════════════════════════════════════════════════════

async function sendChunked(msg) {
  if (!transport) throw new Error('Not connected');
  
  sendInProgress = true;
  stats.retries = 0;
  stats.chunks = 0;
  stats.maxRetryPerChunk = 0;

  const config = transport.config;

  try {
    let seq = 0;
    let i = 0;

    while (i < msg.length) {
      const dataLen = transport.maxDataLenForSeq(seq);
      const payload = `${seq}|${msg.slice(i, i + dataLen)}`;

      let success = false;
      let chunkRetries = 0;
      for (let retry = 0; retry < config.maxRetries && !success; retry++) {
        if (retry > 0) {
          chunkRetries++;
          stats.retries++;
          log(`Retry ${retry} for chunk ${seq}`, 'error');
          transport.rxBuffer = '';
          await delay(config.retryDelay);
        }
        await sendRaw(payload);
        try {
          await transport.waitForAck(payload, config.ackTimeout);
          success = true;
          stats.maxRetryPerChunk = Math.max(stats.maxRetryPerChunk, chunkRetries);
        } catch (e) {
          if (retry === config.maxRetries - 1) throw e;
        }
      }

      i += dataLen;
      seq = (seq + 1) % (config.maxSeq + 1);
      stats.chunks++;
    }
  } finally {
    sendInProgress = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// SEND MESSAGE
// ═══════════════════════════════════════════════════════════════════
async function sendMessage() {
  const msg = dom.messageInput.value;
  if (!msg) return;

  const byteLen = encoder.encode(msg).length;
  const chunkSize = transport ? transport.config.chunkSize || transport.config.maxWriteBytes : 50;

  if (byteLen < chunkSize) {
    await sendRaw(msg);
  } else {
    if (/\s/.test(msg)) {
      log('Long messages must contain NO SPACES', 'error');
      return;
    }
    if (sendInProgress) return;
    await sendChunked(msg);
  }

  dom.messageInput.value = '';
}

// ═══════════════════════════════════════════════════════════════════
// TEST
// ═══════════════════════════════════════════════════════════════════
function makeTestString() {
  let s = '';
  for (let i = 0; i <= 1000; i++) s += i;
  return s;
}

async function runTest() {
  if (!transport) {
    log('Not connected', 'error');
    return;
  }
  
  const testData = makeTestString();
  log(`TEST #${cumulative.tests + 1} start (${testData.length} chars) via ${transport.name.toUpperCase()}`, 'info');

  const t0 = performance.now();
  await sendChunked(testData);
  const elapsed = (performance.now() - t0) / 1000;

  const speed = testData.length / elapsed;
  const attempts = stats.chunks + stats.retries;
  const successRate = ((stats.chunks / attempts) * 100).toFixed(1);

  cumulative.tests++;
  cumulative.bytes += testData.length;
  cumulative.chunks += stats.chunks;
  cumulative.retries += stats.retries;
  cumulative.time += elapsed;
  cumulative.minSpeed = Math.min(cumulative.minSpeed, speed);
  cumulative.maxSpeed = Math.max(cumulative.maxSpeed, speed);
  cumulative.minRetries = Math.min(cumulative.minRetries, stats.retries);
  cumulative.maxRetries = Math.max(cumulative.maxRetries, stats.retries);
  cumulative.maxRetryPerChunk = Math.max(cumulative.maxRetryPerChunk, stats.maxRetryPerChunk);

  const cumAttempts = cumulative.chunks + cumulative.retries;
  const cumSuccessRate = ((cumulative.chunks / cumAttempts) * 100).toFixed(1);
  const avgSpeed = cumulative.bytes / cumulative.time;
  const avgRetries = cumulative.retries / cumulative.tests;

  log(`════════════════════════════════════════`, 'info');
  log(`TEST #${cumulative.tests} COMPLETE (${transport.name.toUpperCase()})`, 'success');
  log(`────────────────────────────────────────`, 'info');
  log(`  Chunks: ${stats.chunks} | Retries: ${stats.retries} | Max retry: ${stats.maxRetryPerChunk} | Success: ${successRate}%`, 'info');
  log(`  Time: ${elapsed.toFixed(2)}s | Speed: ${speed.toFixed(1)} B/s`, 'info');
  log(`════════════════════════════════════════`, 'info');
  log(`CUMULATIVE STATS (${cumulative.tests} tests)`, 'success');
  log(`────────────────────────────────────────`, 'info');
  log(`  Total: ${cumulative.bytes} bytes | ${cumulative.chunks} chunks | ${cumulative.retries} retries`, 'info');
  log(`  Success rate: ${cumSuccessRate}%`, 'info');
  log(`  Speed: min=${cumulative.minSpeed.toFixed(0)} avg=${avgSpeed.toFixed(0)} max=${cumulative.maxSpeed.toFixed(0)} B/s`, 'info');
  log(`  Retries/test: min=${cumulative.minRetries} avg=${avgRetries.toFixed(1)} max=${cumulative.maxRetries}`, 'info');
  log(`  Max retries for single chunk: ${cumulative.maxRetryPerChunk}`, 'info');
  log(`  Total time: ${cumulative.time.toFixed(2)}s`, 'info');
  log(`════════════════════════════════════════`, 'info');
}

// ═══════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════

function initUI() {
  if (dom.connectBtn) dom.connectBtn.onclick = connect;
  if (dom.disconnectBtn) dom.disconnectBtn.onclick = disconnect;
  if (dom.sendBtn) dom.sendBtn.onclick = sendMessage;
  if (dom.messageInput) dom.messageInput.onkeypress = e => { if (e.key === 'Enter') sendMessage(); };
  if (dom.testBtn) dom.testBtn.onclick = runTest;
  if (dom.clearStatsBtn) dom.clearStatsBtn.onclick = clearStats;
  if (dom.clearLogBtn) dom.clearLogBtn.onclick = clearLog;
  if (dom.copyLogBtn) dom.copyLogBtn.onclick = copyLog;
  if (dom.exportLogBtn) dom.exportLogBtn.onclick = exportLog;

  buildEmojiPicker();
  ensureEmojiMatrixGrid();
  initEditablePreview();

  if (dom.sendEmojiBtn) dom.sendEmojiBtn.onclick = sendEmoji;

  if (dom.clearPreviewBtn) dom.clearPreviewBtn.onclick = clearPreview;
  if (dom.testRedBtn) dom.testRedBtn.onclick = () => fillPreview(255, 0, 0);
  if (dom.testGreenBtn) dom.testGreenBtn.onclick = () => fillPreview(0, 255, 0);
  if (dom.testBlueBtn) dom.testBlueBtn.onclick = () => fillPreview(0, 0, 255);
  if (dom.testWhiteBtn) dom.testWhiteBtn.onclick = () => fillPreview(255, 255, 255);
  
  // Check browser support and update UI
  updateBrowserSupport();
}

function updateBrowserSupport() {
  const hasSerial = 'serial' in navigator;
  const hasBluetooth = 'bluetooth' in navigator;
  
  if (dom.transportSelect) {
    // Disable unsupported options
    for (const option of dom.transportSelect.options) {
      if (option.value === 'serial' && !hasSerial) {
        option.disabled = true;
        option.textContent += ' (not supported)';
      }
      if (option.value === 'ble' && !hasBluetooth) {
        option.disabled = true;
        option.textContent += ' (not supported)';
      }
    }
    
    // Select first available option
    if (!hasSerial && hasBluetooth) {
      dom.transportSelect.value = 'ble';
    }
  }
  
  if (!hasSerial && !hasBluetooth) {
    log('⚠️ Neither Web Serial nor Web Bluetooth is supported in this browser. Use Chrome or Edge.', 'error');
  }
}

// Preview editing
let currentBrushColor = { r: 255, g: 0, b: 0 };
let previewColors = [];
let previewIsPainting = false;
let previewDragMode = 'paint';
let previewLastIndex = -1;

function getMatrixSize() {
  return parseInt(dom.matrixSize?.value || '8');
}

function ensurePreviewColorsSize() {
  const size = getMatrixSize();
  const n = size * size;
  if (!Array.isArray(previewColors) || previewColors.length !== n) {
    previewColors = Array.from({ length: n }, () => ({ r: 0, g: 0, b: 0 }));
  }
}

function hasPreviewContent() {
  return previewColors.some(c => c.r > 0 || c.g > 0 || c.b > 0);
}

function setPreviewFromColors(colors, label = null) {
  previewColors = colors.map(c => ({ r: c.r|0, g: c.g|0, b: c.b|0 }));
  paintEmojiMatrix(previewColors);
  selectedEmojiHex = rgbToHex(previewColors);
  if (label && dom.selectedEmojiText) dom.selectedEmojiText.textContent = label;
}

function updateHexFromPreview() {
  selectedEmojiHex = rgbToHex(previewColors);
}

function isPixelOn(color) {
  return (color.r|0) > 10 || (color.g|0) > 10 || (color.b|0) > 10;
}

function setPixel(index, color) {
  if (index < 0 || index >= previewColors.length) return;
  previewColors[index] = { r: color.r|0, g: color.g|0, b: color.b|0 };

  const cell = dom.emojiMatrix?.children?.[index];
  if (!cell) return;
  const on = isPixelOn(previewColors[index]);
  cell.classList.toggle('on', on);
  if (on) {
    cell.style.background = `rgb(${previewColors[index].r}, ${previewColors[index].g}, ${previewColors[index].b})`;
    cell.style.boxShadow = `0 0 8px rgba(${previewColors[index].r}, ${previewColors[index].g}, ${previewColors[index].b}, 0.8)`;
    cell.classList.add('just-painted');
    cell.classList.add('painted-active');
    setTimeout(() => cell.classList.remove('just-painted'), 500);
    setTimeout(() => cell.classList.remove('painted-active'), 800);
  } else {
    cell.style.background = '';
    cell.style.boxShadow = '';
  }
}

function getCellIndexAtPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return -1;
  const cell = el.closest?.('.pixel-cell');
  if (!cell || !dom.emojiMatrix?.contains(cell)) return -1;
  const idx = parseInt(cell.dataset.index || '-1', 10);
  return Number.isFinite(idx) ? idx : -1;
}

function applyToggle(index) {
  const current = previewColors[index] || { r: 0, g: 0, b: 0 };
  if (isPixelOn(current)) {
    setPixel(index, { r: 0, g: 0, b: 0 });
  } else {
    setPixel(index, currentBrushColor);
  }
  updateHexFromPreview();
  selectedEmoji = null;
  if (dom.selectedEmojiText) dom.selectedEmojiText.textContent = 'Custom';
  if (dom.selectedEmojiDescription) dom.selectedEmojiDescription.textContent = 'Your custom creation';
}

function initEditablePreview() {
  if (!dom.emojiMatrix) return;
  if (dom.emojiMatrix.dataset.editableInit === "1") return;
  dom.emojiMatrix.dataset.editableInit = "1";

  if (dom.brushColor) {
    const setFromHex = (hex) => {
      const h = (hex || '').replace('#','');
      if (h.length === 6) {
        currentBrushColor = {
          r: parseInt(h.slice(0,2),16) || 0,
          g: parseInt(h.slice(2,4),16) || 0,
          b: parseInt(h.slice(4,6),16) || 0,
        };
      }
    };
    setFromHex(dom.brushColor.value);
    dom.brushColor.addEventListener('input', (e) => setFromHex(e.target.value));
    
    document.querySelectorAll('.color-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const color = btn.getAttribute('data-color');
        dom.brushColor.value = color;
        setFromHex(color);
        btn.style.transform = 'scale(1.3) rotate(15deg)';
        setTimeout(() => btn.style.transform = '', 200);
      });
    });
  }

  dom.emojiMatrix.addEventListener('contextmenu', (e) => e.preventDefault());

  dom.emojiMatrix.addEventListener('pointerdown', (e) => {
    ensureEmojiMatrixGrid();
    ensurePreviewColorsSize();

    const idx = getCellIndexAtPoint(e.clientX, e.clientY);
    if (idx < 0) return;

    const erase = e.shiftKey || e.altKey || e.button === 2;
    previewDragMode = erase ? 'erase' : 'paint';
    previewIsPainting = true;
    previewLastIndex = -1;

    if (previewDragMode === 'erase') {
      setPixel(idx, { r: 0, g: 0, b: 0 });
      updateHexFromPreview();
    } else {
      applyToggle(idx);
    }

    dom.emojiMatrix.setPointerCapture?.(e.pointerId);
  });

  dom.emojiMatrix.addEventListener('pointermove', (e) => {
    if (!previewIsPainting) return;
    const idx = getCellIndexAtPoint(e.clientX, e.clientY);
    if (idx < 0 || idx === previewLastIndex) return;
    previewLastIndex = idx;

    if (previewDragMode === 'erase') {
      setPixel(idx, { r: 0, g: 0, b: 0 });
    } else {
      setPixel(idx, currentBrushColor);
    }

    updateHexFromPreview();
    selectedEmoji = null;
    if (dom.selectedEmojiText) dom.selectedEmojiText.textContent = 'Custom';
    if (dom.selectedEmojiDescription) dom.selectedEmojiDescription.textContent = 'Your custom creation';
  });

  const stop = () => {
    previewIsPainting = false;
    previewLastIndex = -1;
  };
  dom.emojiMatrix.addEventListener('pointerup', stop);
  dom.emojiMatrix.addEventListener('pointercancel', stop);
  dom.emojiMatrix.addEventListener('pointerleave', stop);
}

function clearPreview() {
  const size = getMatrixSize();
  const n = size * size;
  const colors = Array.from({ length: n }, () => ({ r: 0, g: 0, b: 0 }));
  setPreviewFromColors(colors, 'Custom');
  selectedEmoji = null;
  log('Preview cleared', 'info');
}

function fillPreview(r, g, b) {
  const size = getMatrixSize();
  const n = size * size;
  const colors = Array.from({ length: n }, () => ({ r: r|0, g: g|0, b: b|0 }));
  setPreviewFromColors(colors, 'Test Pattern');
  selectedEmoji = null;
  log(`Test pattern: RGB(${r},${g},${b})`, 'info');
}

// Matrix size selector
if (dom.matrixSize) {
  dom.matrixSize.onchange = async function() {
    const matrixSize = parseInt(this.value);
    
    if (isConnected) {
      await sendMode(matrixSize);
    }
    
    ensureEmojiMatrixGrid();
    
    if (selectedEmoji) {
      const colors = renderEmojiToRGB(selectedEmoji, matrixSize);
      setPreviewFromColors(colors);
      log(`Matrix size changed to ${matrixSize}×${matrixSize}`, 'info');
    }
  };
}

async function sendMode(size) {
  if (!isConnected) {
    log('Not connected', 'error');
    return;
  }
  
  const payload = `MODE:${size}`;
  log(`Setting matrix mode to ${size}×${size}`, 'info');
  await sendRaw(payload);
  await transport.waitForAck(payload);
}

// Brightness control
if (dom.brightnessSlider && dom.brightnessValue) {
  dom.brightnessSlider.max = '100';
  dom.brightnessSlider.min = '10';
  if (parseInt(dom.brightnessSlider.value) > 100) {
    dom.brightnessSlider.value = '10';
  }
  
  dom.brightnessSlider.oninput = function() {
    const percent = Math.round((this.value / 100) * 100);
    dom.brightnessValue.textContent = percent;
  };
  
  dom.brightnessSlider.onchange = async function() {
    if (isConnected) {
      const brightness = parseInt(this.value);
      await sendBrightness(brightness);
    } else {
      log('Connect to micro:bit first', 'warning');
    }
  };
}

async function sendBrightness(brightness) {
  if (!isConnected) {
    log('Not connected', 'error');
    return;
  }
  
  brightness = Math.max(10, Math.min(100, brightness));
  
  const payload = `BRIGHTNESS:${brightness}`;
  log(`Setting brightness to ${brightness}%`, 'info');
  await sendRaw(payload);
  
  try {
    await transport.waitForAck(payload);
  } catch (e) {
    console.log('Brightness ACK timeout (non-critical)');
  }
  
  await delay(100);
}

// Simple mode toggle
if (dom.simpleModeToggle) {
  dom.simpleModeToggle.onchange = function() {
    if (this.checked) {
      dom.emojiMatrix.classList.add('simple-mode');
    } else {
      dom.emojiMatrix.classList.remove('simple-mode');
    }
  };
}

// ═══════════════════════════════════════════════════════════════════
//  💾 SAVE / LOAD DESIGNS
// ═══════════════════════════════════════════════════════════════════

const STORAGE_KEY = 'pixelgateway-saved-designs';

function getSavedDesigns() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveDesigns(designs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(designs));
}

function renderSavedDesignsList() {
  if (!dom.savedDesignsList) return;
  
  const designs = getSavedDesigns();
  dom.savedDesignsList.innerHTML = '';
  
  if (designs.length === 0) {
    if (dom.noSavedDesigns) dom.noSavedDesigns.style.display = 'block';
    return;
  }
  
  if (dom.noSavedDesigns) dom.noSavedDesigns.style.display = 'none';
  
  for (const design of designs) {
    const item = document.createElement('div');
    item.className = 'saved-design-item';
    item.innerHTML = `
      <span class="design-name">${design.name}</span>
      <span class="design-size">${design.size}×${design.size}</span>
      <button class="load-btn" title="Load">📂</button>
      <button class="delete-btn" title="Delete">🗑️</button>
    `;
    
    item.querySelector('.load-btn').onclick = () => loadDesign(design);
    item.querySelector('.delete-btn').onclick = () => deleteDesign(design.id);
    
    dom.savedDesignsList.appendChild(item);
  }
}

function saveCurrentDesign() {
  const name = dom.saveNameInput?.value?.trim();
  if (!name) {
    log('Enter a name for your design', 'error');
    return;
  }
  
  const size = getMatrixSize();
  const designs = getSavedDesigns();
  
  designs.push({
    id: Date.now(),
    name,
    size,
    colors: previewColors.map(c => ({ r: c.r, g: c.g, b: c.b })),
    created: new Date().toISOString()
  });
  
  saveDesigns(designs);
  renderSavedDesignsList();
  
  if (dom.saveNameInput) dom.saveNameInput.value = '';
  log(`Design "${name}" saved!`, 'success');
}

function loadDesign(design) {
  if (dom.matrixSize && dom.matrixSize.value !== String(design.size)) {
    dom.matrixSize.value = String(design.size);
    ensureEmojiMatrixGrid();
  }
  
  setPreviewFromColors(design.colors, design.name);
  log(`Loaded "${design.name}"`, 'success');
}

function deleteDesign(id) {
  const designs = getSavedDesigns().filter(d => d.id !== id);
  saveDesigns(designs);
  renderSavedDesignsList();
  log('Design deleted', 'info');
}

if (dom.saveDesignBtn) {
  dom.saveDesignBtn.onclick = saveCurrentDesign;
}

// ═══════════════════════════════════════════════════════════════════
//  🎬 DEMO ANIMATIONS
// ═══════════════════════════════════════════════════════════════════

let demoAnimationId = null;
let demoRunning = false;

function stopDemoAnimation() {
  demoRunning = false;
  if (demoAnimationId) {
    clearInterval(demoAnimationId);
    demoAnimationId = null;
  }
}

function runDemoLoop(intervalMs, frameFn) {
  stopDemoAnimation();
  demoRunning = true;
  
  const tick = async () => {
    if (!demoRunning) return;
    frameFn();
    paintEmojiMatrix(previewColors);
    selectedEmojiHex = rgbToHex(previewColors);
    
    if (isConnected) {
      await sendCurrentFrame();
    }
  };
  
  tick();
  demoAnimationId = setInterval(tick, intervalMs);
}

function startDemo(demoFn) {
  ensurePreviewColorsSize();
  demoFn();
  log('Demo started', 'info');
}

// Waving Flag Animation
function demoWavingFlagAnim() {
  let phase = 0;
  const colors = [
    { r: 0, g: 60, b: 0 },
    { r: 255, g: 255, b: 255 },
    { r: 255, g: 0, b: 0 }
  ];
  
  runDemoLoop(100, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const wave = Math.sin((x + phase) * 0.5) * 2;
        const stripe = Math.floor((y + wave + size) % size / (size / 3));
        const colorIdx = Math.min(2, Math.max(0, stripe));
        previewColors[y * size + x] = { ...colors[colorIdx] };
      }
    }
    phase += 0.3;
  });
}

// Traffic Light Animation
function demoTrafficLightAnim() {
  let state = 0;
  const states = ['red', 'yellow', 'green'];
  
  runDemoLoop(1000, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    const currentState = states[state % 3];
    
    for (let i = 0; i < size * size; i++) {
      previewColors[i] = { r: 30, g: 30, b: 30 };
    }
    
    const cx = Math.floor(size / 2);
    const radius = Math.floor(size / 4);
    
    let color, cy;
    switch (currentState) {
      case 'red':
        color = { r: 255, g: 0, b: 0 };
        cy = Math.floor(size / 6);
        break;
      case 'yellow':
        color = { r: 255, g: 200, b: 0 };
        cy = Math.floor(size / 2);
        break;
      case 'green':
        color = { r: 0, g: 255, b: 0 };
        cy = Math.floor(size * 5 / 6);
        break;
    }
    
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (dist <= radius) {
          previewColors[y * size + x] = { ...color };
        }
      }
    }
    
    state++;
  });
}

// Heart Beat Animation
function demoHeartBeatAnim() {
  let beat = 0;
  const heartPattern8 = [
    0,1,1,0,0,1,1,0,
    1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,
    0,1,1,1,1,1,1,0,
    0,0,1,1,1,1,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,0,0,0,0,0
  ];
  
  runDemoLoop(100, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    
    const pulse = Math.sin(beat * 0.3) * 0.3 + 0.7;
    const r = Math.floor(255 * pulse);
    
    let pattern = heartPattern8;
    if (size === 16) {
      pattern = [];
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const srcX = Math.floor(x / 2);
          const srcY = Math.floor(y / 2);
          pattern.push(heartPattern8[srcY * 8 + srcX]);
        }
      }
    }
    
    for (let i = 0; i < size * size; i++) {
      previewColors[i] = pattern[i] ? { r, g: 0, b: 0 } : { r: 0, g: 0, b: 0 };
    }
    
    beat++;
  });
}

// Rainbow Wave
function demoRainbowWaveAnim() {
  let offset = 0;
  
  runDemoLoop(50, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const hue = ((x + y + offset) % size) / size;
        const rgb = hslToRgb(hue, 1, 0.5);
        previewColors[y * size + x] = rgb;
      }
    }
    offset++;
  });
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// Spinning Star
function demoSpinningStarAnim() {
  let angle = 0;
  
  runDemoLoop(80, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    const cx = size / 2, cy = size / 2;
    
    for (let i = 0; i < size * size; i++) {
      previewColors[i] = { r: 0, g: 0, b: 0 };
    }
    
    for (let i = 0; i < 5; i++) {
      const a = angle + (i * Math.PI * 2 / 5);
      const len = size / 2 - 1;
      for (let d = 0; d < len; d++) {
        const x = Math.round(cx + Math.cos(a) * d);
        const y = Math.round(cy + Math.sin(a) * d);
        if (x >= 0 && x < size && y >= 0 && y < size) {
          previewColors[y * size + x] = { r: 255, g: 255, b: 0 };
        }
      }
    }
    
    angle += 0.15;
  });
}

// Smiley Animation
function demoSmileyAnim() {
  let bounce = 0;
  
  runDemoLoop(100, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    const scale = size / 16;
    
    for (let i = 0; i < size * size; i++) {
      previewColors[i] = { r: 255, g: 200, b: 0 };
    }
    
    // Eyes
    const eyeY = Math.floor(5 * scale);
    const leftEyeX = Math.floor(5 * scale);
    const rightEyeX = Math.floor(10 * scale);
    const eyeSize = Math.ceil(2 * scale);
    
    for (let dy = 0; dy < eyeSize; dy++) {
      for (let dx = 0; dx < eyeSize; dx++) {
        const li = (eyeY + dy) * size + leftEyeX + dx;
        const ri = (eyeY + dy) * size + rightEyeX + dx;
        if (li < size * size) previewColors[li] = { r: 0, g: 0, b: 0 };
        if (ri < size * size) previewColors[ri] = { r: 0, g: 0, b: 0 };
      }
    }
    
    // Smile
    const smileY = Math.floor(10 * scale + Math.sin(bounce) * scale);
    const smileWidth = Math.floor(8 * scale);
    const smileStart = Math.floor((size - smileWidth) / 2);
    
    for (let x = 0; x < smileWidth; x++) {
      const y = smileY + Math.floor(Math.abs(x - smileWidth/2) / 3);
      if (y < size) {
        previewColors[y * size + smileStart + x] = { r: 0, g: 0, b: 0 };
      }
    }
    
    bounce += 0.3;
  });
}

// Loading Bar
function demoLoadingBarAnim() {
  let progress = 0;
  
  runDemoLoop(150, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    
    for (let i = 0; i < size * size; i++) {
      previewColors[i] = { r: 0, g: 0, b: 0 };
    }
    
    const barY = Math.floor(size / 2);
    const maxProgress = size - 2;
    
    for (let x = 1; x < size - 1; x++) {
      const filled = x <= progress;
      const color = filled ? { r: 0, g: 255, b: 0 } : { r: 50, g: 50, b: 50 };
      previewColors[barY * size + x] = { ...color };
      previewColors[(barY + 1) * size + x] = { ...color };
    }
    
    progress++;
    if (progress > maxProgress) progress = 0;
  });
}

// Fireworks
function demoFireworksAnim() {
  let frame = 0;
  const colors = [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 255, b: 0 },
    { r: 255, g: 0, b: 255 }
  ];
  
  runDemoLoop(100, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    
    for (let i = 0; i < size * size; i++) {
      previewColors[i] = { r: 0, g: 0, b: 0 };
    }
    
    const cx = size / 2, cy = size / 2;
    const maxRadius = size / 2;
    const radius = (frame % 15);
    const color = colors[Math.floor(frame / 15) % colors.length];
    
    for (let angle = 0; angle < Math.PI * 2; angle += 0.3) {
      const x = Math.round(cx + Math.cos(angle) * radius);
      const y = Math.round(cy + Math.sin(angle) * radius);
      
      if (x >= 0 && x < size && y >= 0 && y < size) {
        const brightness = 1 - (radius / maxRadius);
        previewColors[y * size + x] = {
          r: Math.floor(color.r * brightness),
          g: Math.floor(color.g * brightness),
          b: Math.floor(color.b * brightness)
        };
      }
    }
    
    frame++;
  });
}

// Racing Car
function demoRacingCarAnim() {
  let carX = 0;
  
  runDemoLoop(100, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    
    // Grass
    for (let i = 0; i < size * size; i++) {
      previewColors[i] = { r: 0, g: 50, b: 0 };
    }
    
    // Road
    const roadY = Math.floor(size / 2);
    for (let x = 0; x < size; x++) {
      previewColors[(roadY - 1) * size + x] = { r: 100, g: 100, b: 100 };
      previewColors[roadY * size + x] = { r: 100, g: 100, b: 100 };
      previewColors[(roadY + 1) * size + x] = { r: 100, g: 100, b: 100 };
    }
    
    // Car
    if (carX >= 0 && carX < size - 1) {
      previewColors[(roadY - 1) * size + carX] = { r: 255, g: 0, b: 0 };
      previewColors[(roadY - 1) * size + carX + 1] = { r: 255, g: 0, b: 0 };
      previewColors[roadY * size + carX] = { r: 255, g: 0, b: 0 };
      previewColors[roadY * size + carX + 1] = { r: 255, g: 0, b: 0 };
      previewColors[(roadY + 1) * size + carX] = { r: 0, g: 0, b: 0 };
      previewColors[(roadY + 1) * size + carX + 1] = { r: 0, g: 0, b: 0 };
    }
    
    carX++;
    if (carX > size) carX = -2;
  });
}

// Stop Sign
function demoStopSignAnim() {
  let pulse = 0;
  
  runDemoLoop(100, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    
    const brightness = 0.7 + Math.sin(pulse) * 0.3;
    const red = Math.floor(255 * brightness);
    
    for (let i = 0; i < size * size; i++) {
      previewColors[i] = { r: 0, g: 0, b: 0 };
    }
    
    // Octagon shape
    const margin = Math.floor(size / 8);
    for (let y = margin; y < size - margin; y++) {
      for (let x = margin; x < size - margin; x++) {
        // Cut corners for octagon
        const cornerSize = Math.floor(size / 4);
        const inCorner = (
          (x < margin + cornerSize && y < margin + cornerSize && x + y < margin * 2 + cornerSize) ||
          (x >= size - margin - cornerSize && y < margin + cornerSize && (size - x) + y < margin * 2 + cornerSize) ||
          (x < margin + cornerSize && y >= size - margin - cornerSize && x + (size - y) < margin * 2 + cornerSize) ||
          (x >= size - margin - cornerSize && y >= size - margin - cornerSize && (size - x) + (size - y) < margin * 2 + cornerSize)
        );
        
        if (!inCorner) {
          previewColors[y * size + x] = { r: red, g: 0, b: 0 };
        }
      }
    }
    
    pulse += 0.2;
  });
}

// Blinking Eye
function demoBlinkingEyeAnim() {
  let frame = 0;
  const seq = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 2, 1, 0];
  
  runDemoLoop(100, () => {
    const size = getMatrixSize();
    ensurePreviewColorsSize();
    
    const openness = 1 - (seq[frame % seq.length] / 3);
    
    for (let i = 0; i < size * size; i++) {
      previewColors[i] = { r: 255, g: 255, b: 255 };
    }
    
    // Eye outline
    const cx = size / 2, cy = size / 2;
    const eyeHeight = Math.floor(size / 3 * openness);
    const eyeWidth = Math.floor(size / 2.5);
    
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - cx) / eyeWidth;
        const dy = (y - cy) / (eyeHeight || 0.1);
        
        if (dx * dx + dy * dy < 1) {
          previewColors[y * size + x] = { r: 0, g: 0, b: 0 };
        }
      }
    }
    
    // Pupil (when open)
    if (openness > 0.5) {
      const pupilR = Math.floor(size / 8);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
          if (dist < pupilR) {
            previewColors[y * size + x] = { r: 50, g: 100, b: 200 };
          }
        }
      }
    }
    
    frame++;
  });
}

// Demo event listeners
if (dom.demoWavingFlag) dom.demoWavingFlag.addEventListener('click', () => startDemo(demoWavingFlagAnim));
if (dom.demoTrafficLight) dom.demoTrafficLight.addEventListener('click', () => startDemo(demoTrafficLightAnim));
if (dom.demoHeartBeat) dom.demoHeartBeat.addEventListener('click', () => startDemo(demoHeartBeatAnim));
if (dom.demoSpinningStar) dom.demoSpinningStar.addEventListener('click', () => startDemo(demoSpinningStarAnim));
if (dom.demoRainbowWave) dom.demoRainbowWave.addEventListener('click', () => startDemo(demoRainbowWaveAnim));
if (dom.demoSmiley) dom.demoSmiley.addEventListener('click', () => startDemo(demoSmileyAnim));
if (dom.demoLoadingBar) dom.demoLoadingBar.addEventListener('click', () => startDemo(demoLoadingBarAnim));
if (dom.demoFireworks) dom.demoFireworks.addEventListener('click', () => startDemo(demoFireworksAnim));
if (dom.demoRacingCar) dom.demoRacingCar.addEventListener('click', () => startDemo(demoRacingCarAnim));
if (dom.demoStopSign) dom.demoStopSign.addEventListener('click', () => startDemo(demoStopSignAnim));
if (dom.demoBlinkingEye) dom.demoBlinkingEye.addEventListener('click', () => startDemo(demoBlinkingEyeAnim));
if (dom.stopDemo) dom.stopDemo.addEventListener('click', () => {
  stopDemoAnimation();
  log('Demo stopped', 'info');
});

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initUI();
    renderSavedDesignsList();
  });
} else {
  initUI();
  renderSavedDesignsList();
}
